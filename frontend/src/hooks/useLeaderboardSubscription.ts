import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchLeaderboard,
  type LeaderboardEntry,
  type LeaderboardType,
  type TimePeriod,
} from '../services/leaderboardApi';

/**
 * Real-time leaderboard updates — issue #1377.
 *
 * Subscribes to the backend's `leaderboardUpdated` GraphQL subscription over
 * the graphql-transport-ws protocol. If the WebSocket can't be established
 * (or drops), falls back to polling the existing REST leaderboard endpoint
 * so the UI never goes stale.
 */

const GRAPHQL_TRANSPORT_WS_PROTOCOL = 'graphql-transport-ws';
const POLL_INTERVAL_MS = 30_000;

const GQL_TYPE_BY_LEADERBOARD_TYPE: Record<LeaderboardType, string> = {
  'most-burned': 'MOST_BURNED',
  'most-active': 'MOST_ACTIVE',
  newest: 'NEWEST',
  'largest-supply': 'LARGEST_SUPPLY',
  'most-burners': 'MOST_BURNERS',
};

const LEADERBOARD_UPDATED_SUBSCRIPTION = `
  subscription LeaderboardUpdated($type: LeaderboardType, $period: String) {
    leaderboardUpdated(type: $type, period: $period) {
      type
      period
      updatedAt
      entries {
        rank
        tokenAddress
        tokenName
        tokenSymbol
        metric
      }
    }
  }
`;

interface GraphQLLeaderboardEntry {
  rank: number;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  metric: string;
}

interface LeaderboardUpdatedEvent {
  type: string;
  period: string;
  updatedAt: string;
  entries: GraphQLLeaderboardEntry[];
}

export interface UseLeaderboardSubscriptionOptions {
  type?: LeaderboardType;
  period?: TimePeriod;
  /** Skip the WebSocket attempt entirely and only poll — useful for tests / SSR. */
  disableWebSocket?: boolean;
}

export interface UseLeaderboardSubscriptionResult {
  entries: LeaderboardEntry[];
  updatedAt: string | null;
  /** True while receiving push updates over the WebSocket; false while polling. */
  isLive: boolean;
}

function getWsUrl(): string {
  const explicit = (import.meta as any)?.env?.VITE_GRAPHQL_WS_URL;
  if (explicit) return explicit;

  const httpEndpoint =
    (import.meta as any)?.env?.VITE_GRAPHQL_URL ?? '/api/graphql';

  if (httpEndpoint.startsWith('http')) {
    return httpEndpoint.replace(/^http/, 'ws');
  }
  if (typeof window === 'undefined') return '';
  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProtocol}://${window.location.host}${httpEndpoint}`;
}

/**
 * Diff new entries against the previously known ranks to produce an
 * optimistic `rankChange` (positive = moved up) before the server-computed
 * value, if any, is available.
 */
function applyRankChanges(
  entries: GraphQLLeaderboardEntry[],
  previousRanks: Map<string, number>
): LeaderboardEntry[] {
  return entries.map((entry) => {
    const previousRank = previousRanks.get(entry.tokenAddress);
    return {
      tokenAddress: entry.tokenAddress,
      tokenName: entry.tokenName,
      tokenSymbol: entry.tokenSymbol,
      rank: entry.rank,
      value: entry.metric,
      rankChange: previousRank !== undefined ? previousRank - entry.rank : 0,
    };
  });
}

export function useLeaderboardSubscription(
  options: UseLeaderboardSubscriptionOptions = {}
): UseLeaderboardSubscriptionResult {
  const { type = 'most-burned', period = '7d', disableWebSocket = false } = options;

  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);

  const previousRanksRef = useRef<Map<string, number>>(new Map());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const applyEntries = useCallback(
    (incoming: GraphQLLeaderboardEntry[], at: string) => {
      if (!mountedRef.current) return;
      const next = applyRankChanges(incoming, previousRanksRef.current);
      previousRanksRef.current = new Map(next.map((e) => [e.tokenAddress, e.rank]));
      setEntries(next);
      setUpdatedAt(at);
    },
    []
  );

  const poll = useCallback(async () => {
    try {
      const response = await fetchLeaderboard({ type, period, limit: 100 });
      if (!mountedRef.current) return;
      applyEntries(
        response.entries.map((e) => ({
          rank: e.rank,
          tokenAddress: e.tokenAddress,
          tokenName: e.tokenName,
          tokenSymbol: e.tokenSymbol,
          metric: e.value,
        })),
        new Date(response.lastUpdated).toISOString()
      );
    } catch {
      // Keep the last known good state on a transient fetch error.
    }
  }, [type, period, applyEntries]);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    void poll();
    pollTimerRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, [poll]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    previousRanksRef.current = new Map();

    const fallBackToPolling = () => {
      setIsLive(false);
      startPolling();
    };

    if (disableWebSocket || typeof WebSocket === 'undefined') {
      fallBackToPolling();
      return () => {
        mountedRef.current = false;
        stopPolling();
      };
    }

    const url = getWsUrl();
    if (!url) {
      fallBackToPolling();
      return () => {
        mountedRef.current = false;
        stopPolling();
      };
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(url, GRAPHQL_TRANSPORT_WS_PROTOCOL);
    } catch {
      fallBackToPolling();
      return () => {
        mountedRef.current = false;
        stopPolling();
      };
    }

    // Fetch once immediately so the UI has data before the socket connects.
    void poll();

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'connection_init' }));
    };

    socket.onmessage = (event) => {
      let message: any;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === 'connection_ack') {
        socket.send(
          JSON.stringify({
            id: 'leaderboardUpdated',
            type: 'subscribe',
            payload: {
              query: LEADERBOARD_UPDATED_SUBSCRIPTION,
              variables: {
                type: GQL_TYPE_BY_LEADERBOARD_TYPE[type],
                period,
              },
            },
          })
        );
        stopPolling();
        if (mountedRef.current) setIsLive(true);
        return;
      }

      if (message.type === 'next' && message.id === 'leaderboardUpdated') {
        const data: LeaderboardUpdatedEvent | undefined =
          message.payload?.data?.leaderboardUpdated;
        if (data) {
          applyEntries(data.entries, data.updatedAt);
        }
        return;
      }

      if (message.type === 'error' || message.type === 'connection_error') {
        fallBackToPolling();
      }
    };

    socket.onerror = fallBackToPolling;
    socket.onclose = fallBackToPolling;

    return () => {
      mountedRef.current = false;
      stopPolling();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    };
  }, [type, period, disableWebSocket, poll, startPolling, stopPolling, applyEntries]);

  return { entries, updatedAt, isLive };
}
