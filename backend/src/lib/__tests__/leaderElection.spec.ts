/**
 * Unit tests for LeaderElection's fencing-token lifecycle.
 *
 * Uses a mock Redis whose `eval` responds to the acquire/renew and release
 * Lua scripts — no live Redis needed.
 */

import { describe, it, expect, vi } from "vitest";
import type Redis from "ioredis";
import { LeaderElection } from "../leaderElection";

function makeRedisMock(fencingToken = 7) {
  return {
    eval: vi.fn(async (script: string) => {
      // Acquire/renew script returns [status, token]; status 1 = newly acquired.
      if (script.includes("INCR")) return [1, fencingToken];
      // Release script returns number of deleted keys.
      return 1;
    }),
  } as unknown as Redis;
}

describe("LeaderElection.stop()", () => {
  it("resets the cached fencing token after a deliberate stop", async () => {
    const election = new LeaderElection({
      redis: makeRedisMock(7),
      role: "test-role",
      instanceId: "instance-1",
    });

    await election.start();
    expect(election.isLeader()).toBe(true);
    expect(election.getFencingToken()).toBe(7);

    await election.stop();

    expect(election.isLeader()).toBe(false);
    expect(election.getFencingToken()).toBeNull();
  });

  it("still resets the fencing token when the Redis release fails", async () => {
    const redis = makeRedisMock(3);
    const election = new LeaderElection({
      redis,
      role: "test-role",
      instanceId: "instance-1",
    });

    await election.start();
    (redis.eval as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("redis down")
    );

    await election.stop();

    expect(election.isLeader()).toBe(false);
    expect(election.getFencingToken()).toBeNull();
  });
});
