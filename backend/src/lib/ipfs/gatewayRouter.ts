/**
 * IPFS Gateway Failover (#1369)
 *
 * Implements a priority-ordered gateway router that:
 *  1. Tries Pinata (primary), Cloudflare (secondary), public (tertiary) in order
 *  2. Uses a 2-second per-gateway timeout
 *  3. Re-pins to the secondary gateway in the background when the primary fails
 *  4. Emits an `ipfs.gateway.failover` metric with the serving gateway name
 */

import { Counter } from "prom-client";
import { register } from "../metrics/index.js";

// ─── Metric ──────────────────────────────────────────────────────────────────

export const gatewayFailoverCounter = new Counter({
  name: "ipfs_gateway_failover_total",
  help: "Number of IPFS gateway failovers, labelled by the gateway that served the response.",
  labelNames: ["gateway"],
  registers: [register],
});

/** Emit the ipfs.gateway.failover metric. */
function emitFailoverMetric(gatewayName: string): void {
  gatewayFailoverCounter.inc({ gateway: gatewayName });
}

// ─── GatewayClient interface ─────────────────────────────────────────────────

export interface GatewayClient {
  /** Human-readable name used in metrics/logs. */
  readonly name: string;
  /** Fetch raw content for a CID. Must reject/throw on failure. */
  fetch(cid: string, timeoutMs: number): Promise<unknown>;
  /** Pin a CID on this gateway. Returns true if successful. */
  pin(cid: string): Promise<boolean>;
}

// ─── PinataClient ────────────────────────────────────────────────────────────

export class PinataClient implements GatewayClient {
  readonly name = "pinata";
  private readonly gateway: string;

  constructor(
    private readonly apiKey: string = process.env.PINATA_API_KEY ?? "",
    private readonly apiSecret: string = process.env.PINATA_API_SECRET ?? "",
    gateway = process.env.PINATA_GATEWAY_URL ?? "https://gateway.pinata.cloud/ipfs"
  ) {
    this.gateway = gateway;
  }

  async fetch(cid: string, timeoutMs: number): Promise<unknown> {
    const res = await globalThis.fetch(`${this.gateway}/${cid}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Pinata gateway HTTP ${res.status}`);
    return res.json();
  }

  async pin(cid: string): Promise<boolean> {
    try {
      const res = await globalThis.fetch(
        `https://api.pinata.cloud/pinning/pinByHash`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            pinata_api_key: this.apiKey,
            pinata_secret_api_key: this.apiSecret,
          },
          body: JSON.stringify({ hashToPin: cid }),
          signal: AbortSignal.timeout(15_000),
        }
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── CloudflareGatewayClient ─────────────────────────────────────────────────

export class CloudflareGatewayClient implements GatewayClient {
  readonly name = "cloudflare";
  private readonly gateway: string;

  constructor(
    gateway = process.env.CLOUDFLARE_IPFS_GATEWAY ?? "https://cloudflare-ipfs.com/ipfs"
  ) {
    this.gateway = gateway;
  }

  async fetch(cid: string, timeoutMs: number): Promise<unknown> {
    const res = await globalThis.fetch(`${this.gateway}/${cid}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Cloudflare gateway HTTP ${res.status}`);
    return res.json();
  }

  /** Cloudflare IPFS is a read-only public gateway — pinning is not supported. */
  async pin(_cid: string): Promise<boolean> {
    return false;
  }
}

// ─── PublicGatewayClient ─────────────────────────────────────────────────────

export class PublicGatewayClient implements GatewayClient {
  readonly name = "public";
  private readonly gateway: string;

  constructor(
    gateway = process.env.PUBLIC_IPFS_GATEWAY ?? "https://ipfs.io/ipfs"
  ) {
    this.gateway = gateway;
  }

  async fetch(cid: string, timeoutMs: number): Promise<unknown> {
    const res = await globalThis.fetch(`${this.gateway}/${cid}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Public gateway HTTP ${res.status}`);
    return res.json();
  }

  async pin(_cid: string): Promise<boolean> {
    return false;
  }
}

// ─── GatewayRouter ───────────────────────────────────────────────────────────

const GATEWAY_TIMEOUT_MS = 2_000;

export class GatewayRouter {
  private readonly gateways: GatewayClient[];

  constructor(gateways?: GatewayClient[]) {
    this.gateways = gateways ?? [
      new PinataClient(),
      new CloudflareGatewayClient(),
      new PublicGatewayClient(),
    ];
  }

  /**
   * Fetch content for a CID, trying gateways in priority order.
   *
   * - Primary (index 0) is tried first with a 2-second timeout.
   * - On primary failure each subsequent gateway is tried in order.
   * - When a non-primary gateway serves the response, the `ipfs.gateway.failover`
   *   metric is emitted and re-pinning to the primary is triggered in the background.
   * - If all gateways fail, throws an error.
   */
  async fetch(cid: string): Promise<unknown> {
    const errors: Array<{ gateway: string; error: unknown }> = [];

    for (let i = 0; i < this.gateways.length; i++) {
      const gateway = this.gateways[i];
      try {
        const content = await gateway.fetch(cid, GATEWAY_TIMEOUT_MS);

        if (i > 0) {
          // A non-primary gateway served the response — emit metric and re-pin
          emitFailoverMetric(gateway.name);
          this.repinToPrimary(cid).catch(() => {
            // Background — swallow errors so they don't surface to the caller
          });
        }

        return content;
      } catch (err) {
        errors.push({ gateway: gateway.name, error: err });
      }
    }

    const errorDetails = errors
      .map(
        ({ gateway, error }) =>
          `${gateway}: ${error instanceof Error ? error.message : String(error)}`
      )
      .join("; ");

    throw new Error(`All IPFS gateways failed for CID ${cid}: ${errorDetails}`);
  }

  /** Re-pin a CID to the primary (index 0) gateway in the background. */
  private async repinToPrimary(cid: string): Promise<void> {
    const primary = this.gateways[0];
    await primary.pin(cid);
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const gatewayRouter = new GatewayRouter();
