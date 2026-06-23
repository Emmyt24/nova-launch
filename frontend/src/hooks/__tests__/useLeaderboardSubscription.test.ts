import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useLeaderboardSubscription } from '../useLeaderboardSubscription';
import { fetchLeaderboard } from '../../services/leaderboardApi';

vi.mock('../../services/leaderboardApi', () => ({
  fetchLeaderboard: vi.fn(),
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public url: string, public protocol: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  triggerOpen() {
    this.onopen?.();
  }

  triggerMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  triggerError() {
    this.onerror?.();
  }

  triggerClose() {
    this.onclose?.();
  }
}

const mockLeaderboardResponse = (entries: any[] = []) => ({
  entries,
  total: entries.length,
  offset: 0,
  limit: 100,
  period: '7d',
  type: 'most-burned',
  lastUpdated: Date.parse('2026-01-01T00:00:00.000Z'),
});

describe('useLeaderboardSubscription', () => {
  beforeEach(() => {
    vi.mocked(fetchLeaderboard).mockResolvedValue(mockLeaderboardResponse());
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('polling fallback', () => {
    it('polls immediately when WebSocket is disabled', async () => {
      renderHook(() => useLeaderboardSubscription({ disableWebSocket: true }));

      await waitFor(() => expect(fetchLeaderboard).toHaveBeenCalled());
    });

    it('reports isLive=false while polling', async () => {
      const { result } = renderHook(() =>
        useLeaderboardSubscription({ disableWebSocket: true })
      );

      await waitFor(() => expect(fetchLeaderboard).toHaveBeenCalled());
      expect(result.current.isLive).toBe(false);
    });

    it('surfaces entries from the polled response', async () => {
      vi.mocked(fetchLeaderboard).mockResolvedValue(
        mockLeaderboardResponse([
          { tokenAddress: 'GABC', tokenName: 'A', tokenSymbol: 'A', rank: 1, value: '100', rankChange: 0 },
        ])
      );

      const { result } = renderHook(() =>
        useLeaderboardSubscription({ disableWebSocket: true })
      );

      await waitFor(() => expect(result.current.entries).toHaveLength(1));
      expect(result.current.entries[0].tokenAddress).toBe('GABC');
      expect(result.current.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('WebSocket subscription', () => {
    it('sends connection_init on open', async () => {
      renderHook(() => useLeaderboardSubscription());

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];
      act(() => socket.triggerOpen());

      expect(socket.sent).toHaveLength(1);
      expect(JSON.parse(socket.sent[0])).toEqual({ type: 'connection_init' });
    });

    it('subscribes to leaderboardUpdated with mapped GraphQL type/period on ack', async () => {
      renderHook(() => useLeaderboardSubscription({ type: 'newest', period: '24h' }));

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];
      act(() => socket.triggerOpen());
      act(() => socket.triggerMessage({ type: 'connection_ack' }));

      const subscribeMsg = JSON.parse(socket.sent[1]);
      expect(subscribeMsg.type).toBe('subscribe');
      expect(subscribeMsg.id).toBe('leaderboardUpdated');
      expect(subscribeMsg.payload.variables).toEqual({ type: 'NEWEST', period: '24h' });
    });

    it('reports isLive=true after a successful ack', async () => {
      const { result } = renderHook(() => useLeaderboardSubscription());

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];
      act(() => socket.triggerOpen());
      act(() => socket.triggerMessage({ type: 'connection_ack' }));

      await waitFor(() => expect(result.current.isLive).toBe(true));
    });

    it('applies entries delivered over a next message', async () => {
      const { result } = renderHook(() => useLeaderboardSubscription());

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];
      act(() => socket.triggerOpen());
      act(() => socket.triggerMessage({ type: 'connection_ack' }));

      act(() =>
        socket.triggerMessage({
          id: 'leaderboardUpdated',
          type: 'next',
          payload: {
            data: {
              leaderboardUpdated: {
                type: 'MOST_BURNED',
                period: '7d',
                updatedAt: '2026-01-02T00:00:00.000Z',
                entries: [
                  { rank: 1, tokenAddress: 'GNOVA', tokenName: 'Nova', tokenSymbol: 'NOVA', metric: '500' },
                ],
              },
            },
          },
        })
      );

      await waitFor(() => expect(result.current.entries).toHaveLength(1));
      expect(result.current.entries[0]).toMatchObject({
        tokenAddress: 'GNOVA',
        tokenName: 'Nova',
        tokenSymbol: 'NOVA',
        rank: 1,
        value: '500',
      });
      expect(result.current.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it('computes an optimistic rankChange by diffing against the previous ranks', async () => {
      const { result } = renderHook(() => useLeaderboardSubscription());

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];
      act(() => socket.triggerOpen());
      act(() => socket.triggerMessage({ type: 'connection_ack' }));

      const push = (entries: any[]) =>
        act(() =>
          socket.triggerMessage({
            id: 'leaderboardUpdated',
            type: 'next',
            payload: {
              data: {
                leaderboardUpdated: {
                  type: 'MOST_BURNED',
                  period: '7d',
                  updatedAt: '2026-01-02T00:00:00.000Z',
                  entries,
                },
              },
            },
          })
        );

      push([{ rank: 2, tokenAddress: 'GNOVA', tokenName: 'Nova', tokenSymbol: 'NOVA', metric: '500' }]);
      await waitFor(() => expect(result.current.entries).toHaveLength(1));

      push([{ rank: 1, tokenAddress: 'GNOVA', tokenName: 'Nova', tokenSymbol: 'NOVA', metric: '600' }]);
      await waitFor(() => expect(result.current.entries[0].rank).toBe(1));

      // Moved from rank 2 -> rank 1: rankChange = previousRank - newRank = 1.
      expect(result.current.entries[0].rankChange).toBe(1);
    });

    it('falls back to polling when the socket errors', async () => {
      const { result } = renderHook(() => useLeaderboardSubscription());

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];
      act(() => socket.triggerOpen());
      act(() => socket.triggerMessage({ type: 'connection_ack' }));
      await waitFor(() => expect(result.current.isLive).toBe(true));

      act(() => socket.triggerError());

      await waitFor(() => expect(result.current.isLive).toBe(false));
      await waitFor(() => expect(fetchLeaderboard).toHaveBeenCalled());
    });

    it('falls back to polling when the socket closes', async () => {
      const { result } = renderHook(() => useLeaderboardSubscription());

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];
      act(() => socket.triggerOpen());
      act(() => socket.triggerMessage({ type: 'connection_ack' }));
      await waitFor(() => expect(result.current.isLive).toBe(true));

      act(() => socket.triggerClose());

      await waitFor(() => expect(result.current.isLive).toBe(false));
    });

    it('closes the socket on unmount', async () => {
      const { unmount } = renderHook(() => useLeaderboardSubscription());

      await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];

      unmount();

      expect(socket.closed).toBe(true);
    });
  });
});
