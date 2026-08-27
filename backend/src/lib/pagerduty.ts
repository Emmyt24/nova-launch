/**
 * PagerDuty Incident Response Automation (backend-local copy).
 *
 * Sends alerts to PagerDuty Events API v2. Configure via:
 *   PAGERDUTY_ROUTING_KEY — integration key from a PagerDuty Events API v2 integration
 *
 * This intentionally duplicates a small slice of `monitoring/pagerduty/incident-response.ts`
 * (the shared, independently-testable copy — see its own vitest.config.ts and the
 * `incident:test` script in package.json) rather than importing it directly: that file
 * lives outside `backend/src`, and the Docker build only copies `backend/src`, so backend
 * cannot depend on it at either compile time (tsc's rootDir) or runtime. Keep the two in
 * sync if the alerting behavior changes.
 */
import https from "https";

export type IncidentSeverity = "critical" | "error" | "warning" | "info";
export type Priority = "P1" | "P2" | "P3";

export type EventType =
  | "contract-divergence"
  | "auth-failure-spike"
  | "db-connection-loss"
  | "event-listener-down"
  | "api-error-rate-high"
  | "disk-space-low"
  | "dependency-health-critical";

interface SeverityRoute {
  priority: Priority;
  severity: IncidentSeverity;
}

const SEVERITY_ROUTING: Record<EventType, SeverityRoute> = {
  "contract-divergence": { priority: "P1", severity: "critical" },
  "auth-failure-spike": { priority: "P2", severity: "error" },
  "db-connection-loss": { priority: "P1", severity: "critical" },
  "event-listener-down": { priority: "P1", severity: "critical" },
  "api-error-rate-high": { priority: "P2", severity: "error" },
  "disk-space-low": { priority: "P3", severity: "warning" },
  "dependency-health-critical": { priority: "P1", severity: "critical" },
};

export interface IncidentPayload {
  /** Short human-readable summary (max 1024 chars) */
  summary: string;
  /** Stable identifier for deduplication / auto-resolve */
  dedupKey: string;
  /** Source service or component */
  source: string;
  /** Additional context attached to the alert */
  customDetails?: Record<string, unknown>;
  links?: Array<{ href: string; text: string }>;
}

export interface StreamDivergenceDetails {
  streamId: number;
  field: string;
  onChainValue: string;
  projectedValue: string;
}

interface PagerDutyResponse {
  status: string;
  message: string;
  dedup_key: string;
}

const RATE_LIMIT_MS = 60_000;
const _sentAt = new Map<string, number>();

/** Clears rate-limiter state. Intended for use in tests only. */
export function _resetRateLimiter(): void {
  _sentAt.clear();
}

/** Low-level HTTPS POST to PagerDuty Events API v2 */
function sendEvent(body: string): Promise<PagerDutyResponse> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: "events.pagerduty.com",
      path: "/v2/enqueue",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as PagerDutyResponse;
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`PagerDuty API error ${res.statusCode}: ${parsed.message ?? data}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse PagerDuty response: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function triggerIncident(
  payload: IncidentPayload & { severity: IncidentSeverity },
  routingKey: string = process.env.PAGERDUTY_ROUTING_KEY ?? ""
): Promise<PagerDutyResponse> {
  if (!routingKey) {
    throw new Error("PAGERDUTY_ROUTING_KEY is not set. Configure it to enable PagerDuty alerting.");
  }

  const body = JSON.stringify({
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: payload.dedupKey,
    payload: {
      summary: payload.summary,
      severity: payload.severity,
      source: payload.source,
      custom_details: payload.customDetails ?? {},
    },
    links: payload.links ?? [],
  });

  return sendEvent(body);
}

/** Resolves an open PagerDuty incident by dedup key. */
export async function resolveIncident(
  dedupKey: string,
  routingKey: string = process.env.PAGERDUTY_ROUTING_KEY ?? ""
): Promise<PagerDutyResponse> {
  if (!routingKey) {
    throw new Error("PAGERDUTY_ROUTING_KEY is not set.");
  }
  const body = JSON.stringify({ routing_key: routingKey, event_action: "resolve", dedup_key: dedupKey });
  return sendEvent(body);
}

/**
 * Dispatches an alert through the SEVERITY_ROUTING map.
 * - P1 alerts bypass the rate limiter for immediate delivery.
 * - P2/P3 alerts that share a dedupKey with a recent send are silently skipped.
 */
export async function dispatchAlert(
  eventType: EventType,
  payload: IncidentPayload,
  options: { routingKey?: string } = {}
): Promise<PagerDutyResponse | null> {
  const route = SEVERITY_ROUTING[eventType];

  if (route.priority !== "P1") {
    const last = _sentAt.get(payload.dedupKey);
    if (last !== undefined && Date.now() - last < RATE_LIMIT_MS) {
      return null;
    }
  }

  const result = await triggerIncident({ ...payload, severity: route.severity }, options.routingKey);
  _sentAt.set(payload.dedupKey, Date.now());
  return result;
}

function streamDivergenceDedupKey(streamId: number, field: string): string {
  return `nova-stream-divergence-${streamId}-${field}`;
}

/** Alert (P2) when stream reconciliation finds the projection diverging from on-chain state */
export function alertStreamDivergence(details: StreamDivergenceDetails): Promise<PagerDutyResponse> {
  return triggerIncident({
    summary: `Nova Launch: Stream ${details.streamId} ${details.field} diverged from on-chain state`,
    severity: "error",
    dedupKey: streamDivergenceDedupKey(details.streamId, details.field),
    source: "streamReconciliation",
    customDetails: { ...details },
  });
}

/** Resolve a stream divergence incident once reconciliation confirms it cleared */
export function resolveStreamDivergence(streamId: number, field: string): Promise<PagerDutyResponse> {
  return resolveIncident(streamDivergenceDedupKey(streamId, field));
}
