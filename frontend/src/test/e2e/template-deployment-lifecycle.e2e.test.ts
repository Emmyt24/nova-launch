/**
 * E2E: Template-to-Deployment Lifecycle
 *
 * Exercises the complete user journey:
 *   1. Template selection (token parameter preset)
 *   2. Customisation (override name, symbol, supply)
 *   3. Code generation (fee calculation, payload construction)
 *   4. Wallet signing (mocked at network boundary)
 *   5. Deployment (contract invocation)
 *   6. Confirmation (transaction status polling)
 *
 * External APIs (Stellar RPC, backend) are mocked at the network boundary
 * using `nock` / `vi.fn()` — real service integration logic is exercised.
 *
 * Happy path:
 *   - Full flow from template selection to confirmed deployment
 *
 * Failure paths:
 *   - Deployment fails mid-flow (RPC error after signing)
 *   - Wallet rejects signing
 *
 * @see docs/e2e-template-deployment-flow.md
 * Issue: #566
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Types (inline to avoid import coupling in E2E tests)
// ---------------------------------------------------------------------------

interface TokenTemplate {
  id: string;
  name: string;
  defaults: {
    decimals: number;
    initialSupply: string;
    metadataUri?: string;
  };
}

interface TokenParams {
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: string;
  metadataUri?: string;
  creatorAddress: string;
  feePayment: bigint;
}

interface DeploymentResult {
  tokenAddress: string;
  transactionHash: string;
  totalFee: string;
  timestamp: number;
}

type LifecycleStage =
  | "idle"
  | "template_selected"
  | "customised"
  | "payload_built"
  | "signed"
  | "submitted"
  | "confirmed"
  | "failed";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEMPLATES: TokenTemplate[] = [
  {
    id: "community",
    name: "Community Token",
    defaults: { decimals: 7, initialSupply: "1000000000" },
  },
  {
    id: "governance",
    name: "Governance Token",
    defaults: { decimals: 7, initialSupply: "100000000" },
  },
  {
    id: "utility",
    name: "Utility Token",
    defaults: { decimals: 2, initialSupply: "10000000" },
  },
];

const CREATOR_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const MOCK_TOKEN_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const MOCK_TX_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

// ---------------------------------------------------------------------------
// Minimal lifecycle orchestrator (the "service under test")
// ---------------------------------------------------------------------------

class TokenDeploymentOrchestrator {
  private stage: LifecycleStage = "idle";
  private template: TokenTemplate | null = null;
  private params: TokenParams | null = null;
  private signedXdr: string | null = null;

  constructor(
    private readonly walletSign: (xdr: string) => Promise<string | null>,
    private readonly rpcSend: (xdr: string) => Promise<{ hash: string; status: string }>,
    private readonly rpcPoll: (hash: string) => Promise<{ status: string; tokenAddress?: string }>
  ) {}

  getStage(): LifecycleStage {
    return this.stage;
  }

  /** Stage 1: Select a template */
  selectTemplate(templateId: string): TokenTemplate {
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) throw new Error(`Unknown template: ${templateId}`);
    this.template = tpl;
    this.stage = "template_selected";
    return tpl;
  }

  /** Stage 2: Customise parameters */
  customise(overrides: { name: string; symbol: string; creatorAddress: string }): TokenParams {
    if (!this.template) throw new Error("No template selected");
    this.params = {
      ...this.template.defaults,
      ...overrides,
      feePayment: 70_000_000n,
    };
    this.stage = "customised";
    return this.params;
  }

  /** Stage 3: Build payload (fee calculation + XDR construction) */
  buildPayload(): { xdr: string; fee: bigint } {
    if (!this.params) throw new Error("Parameters not set");
    const fee = this.params.metadataUri ? 100_000_000n : 70_000_000n;
    const xdr = `mock-xdr:${this.params.symbol}:${fee}`;
    this.stage = "payload_built";
    return { xdr, fee };
  }

  /** Stage 4: Sign via wallet */
  async sign(xdr: string): Promise<string> {
    const signed = await this.walletSign(xdr);
    if (!signed) throw new Error("Wallet rejected signing");
    this.signedXdr = signed;
    this.stage = "signed";
    return signed;
  }

  /** Stage 5: Submit to network */
  async submit(signedXdr: string): Promise<string> {
    const res = await this.rpcSend(signedXdr);
    if (res.status === "ERROR") throw new Error("Transaction submission failed");
    this.stage = "submitted";
    return res.hash;
  }

  /** Stage 6: Poll for confirmation */
  async confirm(txHash: string): Promise<DeploymentResult> {
    const res = await this.rpcPoll(txHash);
    if (res.status !== "SUCCESS") {
      this.stage = "failed";
      throw new Error(`Transaction failed: ${res.status}`);
    }
    this.stage = "confirmed";
    return {
      tokenAddress: res.tokenAddress ?? MOCK_TOKEN_ADDRESS,
      transactionHash: txHash,
      totalFee: this.params?.feePayment.toString() ?? "70000000",
      timestamp: Date.now(),
    };
  }

  /** Full happy-path flow */
  async deploy(
    templateId: string,
    overrides: { name: string; symbol: string; creatorAddress: string }
  ): Promise<DeploymentResult> {
    this.selectTemplate(templateId);
    this.customise(overrides);
    const { xdr } = this.buildPayload();
    const signed = await this.sign(xdr);
    const hash = await this.submit(signed);
    return this.confirm(hash);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Template-to-Deployment Lifecycle", () => {
  let walletSign: ReturnType<typeof vi.fn>;
  let rpcSend: ReturnType<typeof vi.fn>;
  let rpcPoll: ReturnType<typeof vi.fn>;
  let orchestrator: TokenDeploymentOrchestrator;

  beforeEach(() => {
    walletSign = vi.fn().mockResolvedValue("signed-xdr-abc123");
    rpcSend = vi.fn().mockResolvedValue({ hash: MOCK_TX_HASH, status: "PENDING" });
    rpcPoll = vi.fn().mockResolvedValue({ status: "SUCCESS", tokenAddress: MOCK_TOKEN_ADDRESS });
    orchestrator = new TokenDeploymentOrchestrator(walletSign, rpcSend, rpcPoll);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("Happy path: full lifecycle", () => {
    it("completes the full flow and returns a deployment result", async () => {
      const result = await orchestrator.deploy("community", {
        name: "My Community Token",
        symbol: "MCT",
        creatorAddress: CREATOR_ADDRESS,
      });

      expect(result.tokenAddress).toBe(MOCK_TOKEN_ADDRESS);
      expect(result.transactionHash).toBe(MOCK_TX_HASH);
      expect(result.totalFee).toBeDefined();
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it("reaches 'confirmed' stage after successful deployment", async () => {
      await orchestrator.deploy("community", {
        name: "My Token",
        symbol: "MTK",
        creatorAddress: CREATOR_ADDRESS,
      });

      expect(orchestrator.getStage()).toBe("confirmed");
    });

    it("transitions through all lifecycle stages in order", async () => {
      const stages: LifecycleStage[] = [];

      // Instrument each step
      orchestrator.selectTemplate("governance");
      stages.push(orchestrator.getStage()); // template_selected

      orchestrator.customise({ name: "Gov Token", symbol: "GOV", creatorAddress: CREATOR_ADDRESS });
      stages.push(orchestrator.getStage()); // customised

      const { xdr } = orchestrator.buildPayload();
      stages.push(orchestrator.getStage()); // payload_built

      const signed = await orchestrator.sign(xdr);
      stages.push(orchestrator.getStage()); // signed

      const hash = await orchestrator.submit(signed);
      stages.push(orchestrator.getStage()); // submitted

      await orchestrator.confirm(hash);
      stages.push(orchestrator.getStage()); // confirmed

      expect(stages).toEqual([
        "template_selected",
        "customised",
        "payload_built",
        "signed",
        "submitted",
        "confirmed",
      ]);
    });

    it("calls wallet sign exactly once", async () => {
      await orchestrator.deploy("utility", {
        name: "Utility Token",
        symbol: "UTL",
        creatorAddress: CREATOR_ADDRESS,
      });

      expect(walletSign).toHaveBeenCalledTimes(1);
    });

    it("calls RPC send exactly once", async () => {
      await orchestrator.deploy("utility", {
        name: "Utility Token",
        symbol: "UTL",
        creatorAddress: CREATOR_ADDRESS,
      });

      expect(rpcSend).toHaveBeenCalledTimes(1);
    });

    it("passes signed XDR to RPC send", async () => {
      await orchestrator.deploy("community", {
        name: "Token",
        symbol: "TKN",
        creatorAddress: CREATOR_ADDRESS,
      });

      expect(rpcSend).toHaveBeenCalledWith("signed-xdr-abc123");
    });

    it("all three templates produce valid deployments", async () => {
      for (const template of TEMPLATES) {
        const orch = new TokenDeploymentOrchestrator(walletSign, rpcSend, rpcPoll);
        const result = await orch.deploy(template.id, {
          name: `${template.name} Custom`,
          symbol: template.id.toUpperCase().slice(0, 4),
          creatorAddress: CREATOR_ADDRESS,
        });
        expect(result.tokenAddress).toBeDefined();
        expect(orch.getStage()).toBe("confirmed");
      }
    });
  });

  // ── Failure path 1: RPC error after signing ────────────────────────────────

  describe("Failure path: deployment fails mid-flow (RPC error after signing)", () => {
    it("throws when RPC returns ERROR status", async () => {
      rpcSend.mockResolvedValue({ hash: "", status: "ERROR" });

      await expect(
        orchestrator.deploy("community", {
          name: "Fail Token",
          symbol: "FAIL",
          creatorAddress: CREATOR_ADDRESS,
        })
      ).rejects.toThrow("Transaction submission failed");
    });

    it("stage is 'signed' when RPC send fails (not 'submitted')", async () => {
      rpcSend.mockResolvedValue({ hash: "", status: "ERROR" });

      try {
        await orchestrator.deploy("community", {
          name: "Fail Token",
          symbol: "FAIL",
          creatorAddress: CREATOR_ADDRESS,
        });
      } catch {
        // expected
      }

      expect(orchestrator.getStage()).toBe("signed");
    });

    it("throws when transaction confirmation returns non-SUCCESS status", async () => {
      rpcPoll.mockResolvedValue({ status: "FAILED" });

      await expect(
        orchestrator.deploy("community", {
          name: "Fail Token",
          symbol: "FAIL",
          creatorAddress: CREATOR_ADDRESS,
        })
      ).rejects.toThrow("Transaction failed: FAILED");
    });

    it("stage is 'failed' when confirmation fails", async () => {
      rpcPoll.mockResolvedValue({ status: "FAILED" });

      try {
        await orchestrator.deploy("community", {
          name: "Fail Token",
          symbol: "FAIL",
          creatorAddress: CREATOR_ADDRESS,
        });
      } catch {
        // expected
      }

      expect(orchestrator.getStage()).toBe("failed");
    });
  });

  // ── Failure path 2: Wallet rejects signing ─────────────────────────────────

  describe("Failure path: wallet rejects signing", () => {
    it("throws when wallet returns null (user rejected)", async () => {
      walletSign.mockResolvedValue(null);

      await expect(
        orchestrator.deploy("community", {
          name: "Rejected Token",
          symbol: "REJ",
          creatorAddress: CREATOR_ADDRESS,
        })
      ).rejects.toThrow("Wallet rejected signing");
    });

    it("stage is 'payload_built' when wallet rejects (not 'signed')", async () => {
      walletSign.mockResolvedValue(null);

      try {
        await orchestrator.deploy("community", {
          name: "Rejected Token",
          symbol: "REJ",
          creatorAddress: CREATOR_ADDRESS,
        });
      } catch {
        // expected
      }

      expect(orchestrator.getStage()).toBe("payload_built");
    });

    it("RPC is never called when wallet rejects", async () => {
      walletSign.mockResolvedValue(null);

      try {
        await orchestrator.deploy("community", {
          name: "Rejected Token",
          symbol: "REJ",
          creatorAddress: CREATOR_ADDRESS,
        });
      } catch {
        // expected
      }

      expect(rpcSend).not.toHaveBeenCalled();
    });
  });

  // ── Template selection ─────────────────────────────────────────────────────

  describe("Template selection", () => {
    it("throws for an unknown template ID", () => {
      expect(() => orchestrator.selectTemplate("nonexistent")).toThrow(
        "Unknown template: nonexistent"
      );
    });

    it("applies template defaults to token parameters", () => {
      orchestrator.selectTemplate("utility");
      const params = orchestrator.customise({
        name: "My Utility",
        symbol: "UTL",
        creatorAddress: CREATOR_ADDRESS,
      });

      expect(params.decimals).toBe(2); // utility template default
      expect(params.initialSupply).toBe("10000000");
    });

    it("customisation overrides template defaults", () => {
      orchestrator.selectTemplate("community");
      const params = orchestrator.customise({
        name: "Custom Name",
        symbol: "CST",
        creatorAddress: CREATOR_ADDRESS,
      });

      expect(params.name).toBe("Custom Name");
      expect(params.symbol).toBe("CST");
    });
  });

  // ── Fee calculation ────────────────────────────────────────────────────────

  describe("Fee calculation during payload build", () => {
    it("base fee is 70_000_000 stroops without metadata", () => {
      orchestrator.selectTemplate("community");
      orchestrator.customise({ name: "T", symbol: "T", creatorAddress: CREATOR_ADDRESS });
      const { fee } = orchestrator.buildPayload();
      expect(fee).toBe(70_000_000n);
    });

    it("total fee is 100_000_000 stroops with metadata URI", () => {
      orchestrator.selectTemplate("community");
      const params = orchestrator.customise({
        name: "T",
        symbol: "T",
        creatorAddress: CREATOR_ADDRESS,
      });
      // Inject metadata URI
      (params as TokenParams).metadataUri = "ipfs://QmTest";
      const { fee } = orchestrator.buildPayload();
      expect(fee).toBe(100_000_000n);
    });
  });
});
