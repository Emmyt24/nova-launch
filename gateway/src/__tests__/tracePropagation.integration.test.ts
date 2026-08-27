/**
 * Integration test for #1614: cross-service trace propagation.
 *
 * backend/src/instrumentation.ts instruments the backend with OpenTelemetry,
 * and backend/src/__tests__/otel-trace-propagation.smoke.test.ts proves the
 * backend itself captures an inbound `traceparent` correctly. Neither proves
 * that a trace ID initiated at the client survives the gateway's reverse
 * proxy hop rather than arriving as a disconnected span — that's the gap
 * this test closes.
 *
 * The gateway proxies via http-proxy-middleware (see ../app.ts), which
 * forwards inbound headers to the target by default. This test verifies
 * that holds for `traceparent` specifically, since header stripping during
 * proxying is the most likely place for trace context to be silently
 * dropped, per the issue description.
 *
 * A bare `http` server stands in for the backend so we can inspect exactly
 * which headers arrive after the gateway hop, without needing a running
 * backend + OpenTelemetry collector in the test environment.
 */

import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app";
import { GatewayEnv } from "../config";

const SECRET = "test-gateway-secret";
const SAMPLE_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function validToken(payload: object = { userId: "u1" }) {
  return jwt.sign(payload, SECRET);
}

/** Mock Redis that always reports well under any rate limit. */
function mockRedis() {
  const pipeline = {
    zremrangebyscore: () => pipeline,
    zadd: () => pipeline,
    zcard: () => pipeline,
    expire: () => pipeline,
    exec: async () => [[null, 0], [null, 1], [null, 1], [null, 1]],
  };
  return { pipeline: () => pipeline, on: () => undefined } as any;
}

/**
 * A bare-bones stand-in for the backend service that records the headers it
 * receives, so we can assert the gateway forwarded them unchanged across
 * the proxy hop.
 */
function startStubBackend(): Promise<{
  url: string;
  close: () => Promise<void>;
  receivedHeaders: () => http.IncomingHttpHeaders | undefined;
}> {
  let received: http.IncomingHttpHeaders | undefined;

  const server = http.createServer((req, res) => {
    received = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
        receivedHeaders: () => received,
      });
    });
  });
}

function buildGatewayApp(backendUrl: string) {
  const env: GatewayEnv = {
    PORT: 4000,
    BACKEND_URL: backendUrl,
    JWT_SECRET: SECRET,
    REDIS_URL: "redis://localhost:6379",
    ALLOWED_ORIGINS: ["http://localhost:5173"],
    NODE_ENV: "test",
  };
  return createApp({ env, redis: mockRedis() });
}

describe("cross-service trace propagation through the gateway", () => {
  let stub: Awaited<ReturnType<typeof startStubBackend>>;

  afterEach(async () => {
    await stub?.close();
  });

  it("forwards an explicit W3C traceparent header through gateway -> backend unchanged", async () => {
    stub = await startStubBackend();
    const app = buildGatewayApp(stub.url);

    const res = await request(app)
      .get("/api/tokens")
      .set("Authorization", `Bearer ${validToken()}`)
      .set("traceparent", SAMPLE_TRACEPARENT);

    expect(res.status).toBe(200);

    const forwarded = stub.receivedHeaders()?.traceparent;
    expect(forwarded).toBe(SAMPLE_TRACEPARENT);

    // The trace-id is the second '-'-delimited segment of the traceparent
    // header (version-traceid-parentid-flags). Assert it explicitly, since
    // that's the identifier tying the client, gateway, and backend spans
    // into a single trace.
    const [, expectedTraceId] = SAMPLE_TRACEPARENT.split("-");
    const [, forwardedTraceId] = String(forwarded).split("-");
    expect(forwardedTraceId).toBe(expectedTraceId);
  });

  it("passes through cleanly with no error when the client sends no trace header", async () => {
    stub = await startStubBackend();
    const app = buildGatewayApp(stub.url);

    const res = await request(app)
      .get("/api/tokens")
      .set("Authorization", `Bearer ${validToken()}`);

    expect(res.status).toBe(200);
    // The gateway must not fabricate a traceparent — origination of a fresh
    // trace when none is supplied is the backend's responsibility (see
    // backend/src/__tests__/otel-trace-propagation.smoke.test.ts, which
    // proves the backend does exactly that rather than erroring).
    expect(stub.receivedHeaders()?.traceparent).toBeUndefined();
  });
});
