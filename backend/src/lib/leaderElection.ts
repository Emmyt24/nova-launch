/**
 * Redis-based distributed leader election with fencing tokens.
 *
 * Gives a fleet of identical worker instances (e.g. multiple
 * StellarEventListener processes) a single elected leader at a time, with
 * automatic failover if the leader crashes or its host dies.
 *
 * Mechanics:
 *   - Leadership is a renewable lease: `SET <lockKey> <instanceId> PX <ttlMs> NX`.
 *     The holder renews the lease on a fixed interval (`renewIntervalMs`,
 *     which must be well below `ttlMs`); if it stops renewing (crash, GC
 *     pause, network partition), the lease expires and any standby can win it.
 *   - A monotonically increasing fencing token is stored in a separate,
 *     non-expiring key. It is only incremented when the lock transitions
 *     from unheld/expired to held (a genuinely new election) — never on a
 *     same-holder renewal. Every instance that has ever held leadership knows
 *     the fencing token it was issued; callers must pass that token to
 *     `validateFencingToken` before any side effect that must not be
 *     duplicated (e.g. advancing a durable cursor). If a newer election has
 *     since happened, the stored counter has moved past the caller's token
 *     and the check fails — this is what makes a demoted former leader
 *     provably unable to commit a stale write, even if it hasn't yet noticed
 *     it lost the lease (clock skew, slow GC, delayed network partition
 *     detection, etc.).
 *
 * Bounded failover window: in the worst case a dead leader's lease is not
 * detected as expired until just before its next renewal was due, so the
 * window between leader death and a standby taking over is bounded by
 * `ttlMs + renewIntervalMs` (lease must fully expire, then the standby's own
 * next acquire attempt — up to one renew interval later — must observe it).
 * With the defaults below (TTL 10s, renew every 3s) that bound is 13s.
 *
 * Acquire/renew is a single Lua script so the "is it free / do I already
 * hold it / is it held by someone else" check-and-set is atomic — the same
 * approach used by `../lib/lock.ts` for campaign step locks.
 */

import Redis from "ioredis";
import { Counter, register } from "prom-client";

/** Default lease TTL in milliseconds. */
export const LEADER_LOCK_TTL_MS = 10_000;

/** Default lease renewal interval in milliseconds. Must be well below the TTL. */
export const LEADER_RENEW_INTERVAL_MS = 3_000;

const KEY_PREFIX = "leader_election";

export type ElectionEventName = "became-leader" | "lost-leadership" | "fencing-token-rejected";

const leaderElectionEventsTotal = new Counter({
  name: "leader_election_events_total",
  help: "Count of leader election events by type and role.",
  labelNames: ["event", "role"],
  registers: [register],
});

function logElectionEvent(event: ElectionEventName, role: string, instanceId: string, details: Record<string, unknown> = {}): void {
  leaderElectionEventsTotal.inc({ event, role });
  console.log(
    JSON.stringify({
      component: "LeaderElection",
      event,
      role,
      instanceId,
      timestamp: new Date().toISOString(),
      ...details,
    }),
  );
}

export interface LeaderElectionEvents {
  onBecameLeader?(fencingToken: number): void;
  onLostLeadership?(reason: string): void;
}

export interface LeaderElectionOptions {
  redis: Redis;
  /** Logical role/lock name — all instances contending for the same leadership must share this. */
  role: string;
  /** Unique identifier for this process instance (e.g. `${hostname}:${pid}:${randomUUID()}`). */
  instanceId: string;
  ttlMs?: number;
  renewIntervalMs?: number;
  events?: LeaderElectionEvents;
}

// KEYS[1] = lock key, KEYS[2] = fencing token counter key
// ARGV[1] = instanceId, ARGV[2] = ttlMs
// Returns {status, token}: status 1 = newly acquired, 2 = renewed, 0 = held by another instance.
const ACQUIRE_OR_RENEW_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == false then
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
  local token = redis.call("INCR", KEYS[2])
  return {1, token}
elseif current == ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  local token = tonumber(redis.call("GET", KEYS[2]))
  return {2, token}
else
  return {0, 0}
end
`;

// KEYS[1] = fencing token counter key
// ARGV[1] = attempted token
// Returns 1 if ARGV[1] equals the current counter value (still valid), else 0.
const VALIDATE_FENCING_TOKEN_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if tonumber(ARGV[1]) == current then
  return 1
else
  return 0
end
`;

// KEYS[1] = lock key
// ARGV[1] = instanceId
// Releases the lock only if still held by this instance (compare-and-delete).
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export class LeaderElection {
  private readonly redis: Redis;
  private readonly role: string;
  private readonly instanceId: string;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly events: LeaderElectionEvents;

  private fencingToken: number | null = null;
  private leader = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  constructor(options: LeaderElectionOptions) {
    this.redis = options.redis;
    this.role = options.role;
    this.instanceId = options.instanceId;
    this.ttlMs = options.ttlMs ?? LEADER_LOCK_TTL_MS;
    this.renewIntervalMs = options.renewIntervalMs ?? LEADER_RENEW_INTERVAL_MS;
    this.events = options.events ?? {};
  }

  private lockKey(): string {
    return `${KEY_PREFIX}:${this.role}:lock`;
  }

  private fencingKey(): string {
    return `${KEY_PREFIX}:${this.role}:fencing_token`;
  }

  /** Whether this instance currently believes it holds leadership. */
  isLeader(): boolean {
    return this.leader;
  }

  /** The fencing token issued for this instance's current (or most recent) leadership term, if any. */
  getFencingToken(): number | null {
    return this.fencingToken;
  }

  /**
   * Attempts to acquire the lease if free, or renew it if already held by
   * this instance. Safe to call repeatedly — this is the operation the
   * internal heartbeat runs on `renewIntervalMs`.
   */
  async tryAcquireOrRenew(): Promise<void> {
    let result: [number, number];
    try {
      result = (await this.redis.eval(
        ACQUIRE_OR_RENEW_SCRIPT,
        2,
        this.lockKey(),
        this.fencingKey(),
        this.instanceId,
        this.ttlMs,
      )) as [number, number];
    } catch (err) {
      // Redis unavailable — fail closed: we cannot safely claim leadership
      // without the coordination store, so treat this as a lost lease.
      if (this.leader) {
        this.leader = false;
        this.events.onLostLeadership?.("redis_unavailable");
        logElectionEvent("lost-leadership", this.role, this.instanceId, {
          reason: "redis_unavailable",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    const [status, token] = result;

    if (status === 1) {
      this.fencingToken = token;
      this.leader = true;
      this.events.onBecameLeader?.(token);
      logElectionEvent("became-leader", this.role, this.instanceId, { fencingToken: token });
    } else if (status === 2) {
      this.fencingToken = token;
      this.leader = true;
    } else {
      if (this.leader) {
        this.leader = false;
        this.events.onLostLeadership?.("lease_lost_to_another_instance");
        logElectionEvent("lost-leadership", this.role, this.instanceId, {
          reason: "lease_lost_to_another_instance",
        });
      }
    }
  }

  /**
   * Validates that `token` is still the current fencing token for this role
   * — i.e. no newer leadership term has begun since it was issued. Callers
   * MUST call this immediately before any write that must not be duplicated
   * by a demoted former leader, and must abort the write if it returns false.
   */
  async validateFencingToken(token: number): Promise<boolean> {
    const valid = (await this.redis.eval(
      VALIDATE_FENCING_TOKEN_SCRIPT,
      1,
      this.fencingKey(),
      token,
    )) as number;

    if (valid !== 1) {
      logElectionEvent("fencing-token-rejected", this.role, this.instanceId, {
        attemptedToken: token,
      });
      return false;
    }
    return true;
  }

  /** Starts the heartbeat: attempts acquisition immediately, then on `renewIntervalMs`. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.tryAcquireOrRenew();
    this.timer = setInterval(() => {
      void this.tryAcquireOrRenew();
    }, this.renewIntervalMs);
    this.timer.unref?.();
  }

  /** Stops the heartbeat and releases the lease if currently held. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.leader) {
      try {
        await this.redis.eval(RELEASE_SCRIPT, 1, this.lockKey(), this.instanceId);
      } catch {
        // Best-effort release — the lease will still expire via TTL.
      }
      this.leader = false;
    }
  }
}
