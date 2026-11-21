import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const burnTokensMock = vi.fn();

vi.mock("@/services/stellar-service-integration", () => ({
  stellarService: {
    burnTokens: burnTokensMock,
  },
}));

import { POST } from "../burn/route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/burn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/burn", () => {
  beforeEach(() => {
    burnTokensMock.mockReset();
  });

  it("performs a burn and returns the result", async () => {
    burnTokensMock.mockResolvedValue({ hash: "abc123", ledger: 42 });

    const response = await POST(
      makeRequest({ publicKey: "GABC", amount: "10" }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ hash: "abc123", ledger: 42 });
    expect(burnTokensMock).toHaveBeenCalledWith({
      publicKey: "GABC",
      amount: "10",
      assetCode: undefined,
      assetIssuer: undefined,
    });
  });

  it("rejects an invalid request body", async () => {
    const response = await POST(makeRequest({ amount: "-5" }));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.success).toBe(false);
    expect(burnTokensMock).not.toHaveBeenCalled();
  });
});
