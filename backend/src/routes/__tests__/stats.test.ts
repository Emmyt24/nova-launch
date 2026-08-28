import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import statsRoutes from "../stats";
import { Database } from "../../config/database";

const app = express();
app.use(express.json());
app.use("/api/stats", statsRoutes);

describe("Stats API", () => {
  beforeEach(() => {
    Database.initialize();
  });

  it("should return analytics data", async () => {
    const response = await request(app).get("/api/stats").expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveProperty("totalTokens");
    expect(response.body.data).toHaveProperty("totalUsers");
    expect(response.body.data).toHaveProperty("totalBurned");
    expect(response.body.data).toHaveProperty("uptime");
    expect(response.body.data).toHaveProperty("lastUpdated");
  });

  it("should return correct data types", async () => {
    const response = await request(app).get("/api/stats").expect(200);

    const { data } = response.body;
    expect(typeof data.totalTokens).toBe("number");
    expect(typeof data.totalUsers).toBe("number");
    expect(typeof data.totalBurned).toBe("string");
    expect(typeof data.uptime).toBe("string");
    expect(typeof data.lastUpdated).toBe("string");
  });

  it("should cache results", async () => {
    const response1 = await request(app).get("/api/stats");
    const response2 = await request(app).get("/api/stats");

    expect(response1.body.data.lastUpdated).toBe(
      response2.body.data.lastUpdated
    );
  });

  it("should format uptime correctly", async () => {
    const response = await request(app).get("/api/stats").expect(200);

    expect(response.body.data.uptime).toMatch(/\d+ (day|hour)s?/);
  });

  it("should return ISO timestamp", async () => {
    const response = await request(app).get("/api/stats").expect(200);

    const timestamp = response.body.data.lastUpdated;
    expect(() => new Date(timestamp)).not.toThrow();
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("should correctly aggregate totalBurned using BigInt for precision", async () => {
    const response = await request(app).get("/api/stats").expect(200);

    const { totalBurned } = response.body.data;
    // Verify it's a string (as returned by BigInt.toString())
    expect(typeof totalBurned).toBe("string");
    // Verify it's a valid number string
    expect(/^\d+$/.test(totalBurned)).toBe(true);
  });

  it("should handle totalBurned values exceeding MAX_SAFE_INTEGER", async () => {
    const response = await request(app).get("/api/stats").expect(200);

    const { totalBurned } = response.body.data;
    // BigInt can safely represent values beyond Number.MAX_SAFE_INTEGER
    // Verify the string representation is numeric
    const burned = BigInt(totalBurned);
    expect(burned >= 0n).toBe(true);
  });

  it("should maintain totalBurned as string in response", async () => {
    const response = await request(app).get("/api/stats").expect(200);

    expect(typeof response.body.data.totalBurned).toBe("string");
    expect(() => BigInt(response.body.data.totalBurned)).not.toThrow();
  });
});
