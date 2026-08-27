import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateGatewayEnv } from "../config";

/**
 * Port resolution: the gateway must honour the plain `PORT` variable (which the
 * backend service already uses) as well as the historical `GATEWAY_PORT`, with
 * `PORT` taking precedence when both are set.
 */
describe("validateGatewayEnv — port resolution", () => {
  const saved = {
    PORT: process.env.PORT,
    GATEWAY_PORT: process.env.GATEWAY_PORT,
  };

  beforeEach(() => {
    delete process.env.PORT;
    delete process.env.GATEWAY_PORT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("respects PORT when it is set", () => {
    process.env.PORT = "5000";
    expect(validateGatewayEnv().PORT).toBe(5000);
  });

  it("falls back to GATEWAY_PORT when PORT is absent", () => {
    process.env.GATEWAY_PORT = "4321";
    expect(validateGatewayEnv().PORT).toBe(4321);
  });

  it("prefers PORT over GATEWAY_PORT when both are set", () => {
    process.env.PORT = "5000";
    process.env.GATEWAY_PORT = "4321";
    expect(validateGatewayEnv().PORT).toBe(5000);
  });

  it("defaults to 4000 when neither is set", () => {
    expect(validateGatewayEnv().PORT).toBe(4000);
  });
});
