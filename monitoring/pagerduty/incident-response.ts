/**
 * PagerDuty Incident Response Automation
 *
 * Sends alerts to PagerDuty Events API v2 and manages incident lifecycle.
 * Configure via environment variables:
 *   PAGERDUTY_ROUTING_KEY  — integration key from a PagerDuty Events API v2 integration
 *   PAGERDUTY_API_TOKEN    — REST API token for incident management (optional)
 */

import https from "https";

/** Severity levels mapped to PagerDuty event severities */
export type IncidentSeverity = "critical" | "error" | "warning" | "info";

/** Internal priority tiers used for escalation and rate-limiting decisions */
export type Priority = "P1" | "P2" | "P3";

/** Known event types that can be routed through SEVERITY_ROUTING */
export type EventType =
  | "contract-divergence"
  | "auth-failure-spike"
  | "db-connection-loss"
  | "event-listener-down"
  | "api-error-rate-high"
  | "disk-space-low"
  | "dependency-health-critical";

export interface SeverityRoute {
  priority: Priority;
  severity: IncidentSeverity;
  escalationPolicyId: string;
}

/** Maps each event type to its priority tier, PagerDuty severity, and escalation policy */
export const SEVERITY_ROUTING: Record<EventType, SeverityRoute> = {
  "contract-divergence": {
    priority: "P1",
    severity: "critical",
    escalationPolicyId: "EP-CRITICAL-001",
  },
  "auth-failure-spike": {
    priority: "P2",
    severity: "error",
    escalationPolicyId: "EP-SECURITY-002",
  },
  "db-connection-loss": {
    priority: "P1",
    severity: "critical",
    escalationPolicyId: "EP-CRITICAL-001",
  },
  "event-listener-down": {
    priority: "P1",
    severity: "critical",
    escalationPolicyId: "EP-CRITICAL-001",
  },
  "api-error-rate-high": {
    priority: "P2",
    severity: "error",
    escalationPolicyId: "EP-BACKEND-002",
  },
  "disk-space-low": {
    priority: "P3",
    severity: "warning",
    escalationPolicyId: "EP-INFRA-003",
  },
  "dependency-health-critical": {
    priority: "P1",
    severity: "critical",
    escalationPolicyId: "EP-CRITICAL-001",
  },
};

export interface DryRunResult {
  dryRun: true;
  eventType: EventType;
  priority: Priority;
  severity: IncidentSeverity;
  escalationPolicyId: string;
}

export interface RateLimitedResult {
  rateLimited: true;
  dedupKey: string;
  nextAllowedAt: number;
}

// ---------------------------------------------------------------------------
// Rate limiter — P1 always bypasses; P2/P3 are subject to a per-key cooldown
// ---------------------------------------------------------------------------

const _sentAt = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;

/** Clears rate-limiter state. Intended for use in tests only. */
export function _resetRateLimiter(): void {
  _sentAt.clear();
}

/**
 * Dispatches an alert through the SEVERITY_ROUTING map.
 * - Dry-run mode returns the resolved route without making an API call.
 * - P1 alerts bypass the rate limiter for immediate delivery.
 * - P2/P3 alerts that share a dedupKey with a recent send return RateLimitedResult.
 */
export async function dispatchAlert(
  eventType: EventType,
  payload: Omit<IncidentPayload, "severity">,
  options: {
    dryRun?: boolean;
    routingKey?: string;
  } = {}
): Promise<PagerDutyResponse | DryRunResult | RateLimitedResult> {
  const route = SEVERITY_ROUTING[eventType];

  if (options.dryRun) {
    return {
      dryRun: true,
      eventType,
      priority: route.priority,
      severity: route.severity,
      escalationPolicyId: route.escalationPolicyId,
    };
  }

  if (route.priority !== "P1") {
    const last = _sentAt.get(payload.dedupKey);
    if (last !== undefined && Date.now() - last < RATE_LIMIT_MS) {
      return {
        rateLimited: true,
        dedupKey: payload.dedupKey,
        nextAllowedAt: last + RATE_LIMIT_MS,
      };
    }
  }

  const result = await triggerIncident(
    { ...payload, severity: route.severity },
    options.routingKey
  );

  _sentAt.set(payload.dedupKey, Date.now());
  return result;
}

export interface IncidentPayload {
  /** Short human-readable summary (max 1024 chars) */
  summary: string;
  severity: IncidentSeverity;
  /** Stable identifier for deduplication / auto-resolve */
  dedupKey: string;
  /** Source service or component */
  source: string;
  /** Additional context attached to the alert */
  customDetails?: Record<string, unknown>;
  /** Link to runbook or dashboard */
  links?: Array<{ href: string; text: string }>;
}

export interface PagerDutyResponse {
  status: string;
  message: string;
  dedup_key: string;
}

/**
 * Sends a trigger event to PagerDuty Events API v2.
 * Returns the dedup_key so callers can resolve the incident later.
 */
export async function triggerIncident(
  payload: IncidentPayload,
  routingKey: string = process.env.PAGERDUTY_ROUTING_KEY ?? ""
): Promise<PagerDutyResponse> {
  if (!routingKey) {
    throw new Error(
      "PAGERDUTY_ROUTING_KEY is not set. Configure it to enable PagerDuty alerting."
    );
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

/**
 * Resolves an open PagerDuty incident by dedup key.
 */
export async function resolveIncident(
  dedupKey: string,
  routingKey: string = process.env.PAGERDUTY_ROUTING_KEY ?? ""
): Promise<PagerDutyResponse> {
  if (!routingKey) {
    throw new Error("PAGERDUTY_ROUTING_KEY is not set.");
  }

  const body = JSON.stringify({
    routing_key: routingKey,
    event_action: "resolve",
    dedup_key: dedupKey,
  });

  return sendEvent(body);
}

/**
 * Acknowledges an open PagerDuty incident by dedup key.
 */
export async function acknowledgeIncident(
  dedupKey: string,
  routingKey: string = process.env.PAGERDUTY_ROUTING_KEY ?? ""
): Promise<PagerDutyResponse> {
  if (!routingKey) {
    throw new Error("PAGERDUTY_ROUTING_KEY is not set.");
  }

  const body = JSON.stringify({
    routing_key: routingKey,
    event_action: "acknowledge",
    dedup_key: dedupKey,
  });

  return sendEvent(body);
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
            reject(
              new Error(
                `PagerDuty API error ${res.statusCode}: ${parsed.message ?? data}`
              )
            );
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

// ---------------------------------------------------------------------------
// Pre-built incident helpers for common Nova Launch alert scenarios
// ---------------------------------------------------------------------------

/** Alert when the Stellar event listener falls behind or stops processing */
export function alertEventListenerDown(details?: Record<string, unknown>) {
  return triggerIncident({
    summary: "Nova Launch: Stellar event listener is not processing events",
    severity: "critical",
    dedupKey: "nova-event-listener-down",
    source: "stellarEventListener",
    customDetails: details,
    links: [
      {
        href: "https://github.com/Emmyt24/Nova-launch/blob/main/docs/PRODUCTION_INTEGRATION_RUNBOOK.md",
        text: "Runbook",
      },
    ],
  });
}

/** Alert when backend API error rate exceeds threshold */
export function alertHighApiErrorRate(
  errorRate: number,
  details?: Record<string, unknown>
) {
  return triggerIncident({
    summary: `Nova Launch: API error rate is ${errorRate.toFixed(1)}% (threshold: 5%)`,
    severity: errorRate >= 20 ? "critical" : "error",
    dedupKey: "nova-api-high-error-rate",
    source: "backend-api",
    customDetails: { errorRate, ...details },
  });
}

/** Alert when database connection pool is exhausted */
export function alertDatabasePoolExhausted(details?: Record<string, unknown>) {
  return triggerIncident({
    summary: "Nova Launch: Database connection pool exhausted",
    severity: "critical",
    dedupKey: "nova-db-pool-exhausted",
    source: "prisma",
    customDetails: details,
  });
}

/** Resolve the event listener incident once it recovers */
export function resolveEventListenerDown() {
  return resolveIncident("nova-event-listener-down");
}

/** Resolve the API error rate incident once it recovers */
export function resolveHighApiErrorRate() {
  return resolveIncident("nova-api-high-error-rate");
}

export interface StreamDivergenceDetails {
  [key: string]: unknown;
  streamId: number;
  field: string;
  onChainValue: string;
  projectedValue: string;
}

/** Build the dedup key for a stream divergence so it can be resolved later */
function streamDivergenceDedupKey(streamId: number, field: string): string {
  return `nova-stream-divergence-${streamId}-${field}`;
}

/** Alert (P2) when stream reconciliation finds the projection diverging from on-chain state */
export function alertStreamDivergence(details: StreamDivergenceDetails) {
  return triggerIncident({
    summary: `Nova Launch: Stream ${details.streamId} ${details.field} diverged from on-chain state`,
    severity: "error",
    dedupKey: streamDivergenceDedupKey(details.streamId, details.field),
    source: "streamReconciliation",
    customDetails: details,
  });
}

/** Resolve a stream divergence incident once reconciliation confirms it cleared */
export function resolveStreamDivergence(streamId: number, field: string) {
  return resolveIncident(streamDivergenceDedupKey(streamId, field));
}
