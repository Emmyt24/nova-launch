import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockPing = vi.fn();

vi.mock("../../prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("../../db", () => ({
  checkDatabaseHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));
vi.mock("../../redis", () => ({
  getRedis: () => ({ status: "ready", ping: mockPing }),
}));

global.fetch = vi.fn();

const { HealthService } = await import("../health.service");

describe("HealthService per-dependency reporting (#2194)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as any).mockResolvedValue({ ok: true, status: 200 });
    mockPing.mockResolvedValue("PONG");
    // fresh instance so the 30s result cache doesn't leak between tests
    (HealthService as any).instance = undefined;
  });

  afterEach(() => {
    delete process.env.HEALTH_TIMEOUT_REDIS_MS;
  });

  it("reports database, redis, stellar RPC and ipfs separately", async () => {
    const result = await HealthService.getInstance().checkHealth();
    expect(result.status).toBe("healthy");
    for (const key of ["database", "redis", "stellarSoroban", "ipfs"]) {
      expect((result.services as any)[key].status).toBe("up");
    }
  });

  it("marks only redis degraded when Redis is unreachable", async () => {
    mockPing.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await HealthService.getInstance().checkHealth();
    expect(result.services.redis.status).toBe("degraded");
    expect(result.services.redis.error).toContain("ECONNREFUSED");
    expect(result.services.database.status).toBe("up");
    expect(result.status).toBe("degraded");
  });

  it("applies the per-dependency Redis timeout", async () => {
    process.env.HEALTH_TIMEOUT_REDIS_MS = "20";
    mockPing.mockReturnValue(new Promise(() => {}));
    const result = await HealthService.getInstance().checkHealth();
    expect(result.services.redis.status).toBe("degraded");
    expect(result.services.redis.error).toContain("timeout");
    expect(result.services.ipfs.status).toBe("up");
  });

  it("marks only ipfs down when the gateway fails", async () => {
    (global.fetch as any).mockImplementation(async (url: string) => {
      if (String(url).includes("ipfs")) throw new Error("gateway down");
      return { ok: true, status: 200 };
    });
    const result = await HealthService.getInstance().checkHealth();
    expect(result.services.ipfs.status).toBe("down");
    expect(result.services.redis.status).toBe("up");
  });
});
