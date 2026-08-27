import pinataSDK from "@pinata/sdk";
import NodeCache from "node-cache";
import { Counter } from "prom-client";
import { CircuitBreaker, registerCircuitBreaker } from "../circuitBreaker.js";
import { register } from "../metrics/index.js";
import { CIDMismatchError, verifyCIDContent, verifyMetadataCID } from "./cidVerification.js";
import { pinataQueue, type PinataQueueMetrics } from "./pinataQueue.js";
import { gatewayRouter } from "./gatewayRouter.js";

const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

const ipfsCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  successThreshold: 2,
  timeoutMs: 30000, // 30 seconds before retry
});
// Retry-with-backoff for transient (429/5xx) failures is handled by
// `pinataQueue` itself; this breaker just protects against sustained outages.
// Registered here so its state is visible via GET /health/detailed.
registerCircuitBreaker("pinata", ipfsCircuitBreaker);

const PINATA_BASE_URL = "https://api.pinata.cloud";
const CREDENTIAL_VALIDATION_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Prometheus metric: metadata.cid_mismatch counter
// ---------------------------------------------------------------------------

export const metadataCidMismatchCounter = new Counter({
  name: "metadata_cid_mismatch_total",
  help: "Total number of CID integrity mismatches detected on metadata retrieval",
  labelNames: ["cid"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Credentials management
// ---------------------------------------------------------------------------

interface PinataCredentials {
  apiKey: string;
  apiSecret: string;
}

let activeCredentials: PinataCredentials = {
  apiKey: process.env.PINATA_API_KEY ?? "",
  apiSecret: process.env.PINATA_API_SECRET ?? "",
};

// Optional hot-swap credentials. If the deployment environment provides
// PINATA_API_KEY_NEXT and PINATA_API_SECRET_NEXT before the first Pinata call,
// the system validates them and promotes them to live credentials at runtime.
let stagedCredentials: PinataCredentials | null =
  process.env.PINATA_API_KEY_NEXT && process.env.PINATA_API_SECRET_NEXT
    ? {
        apiKey: process.env.PINATA_API_KEY_NEXT,
        apiSecret: process.env.PINATA_API_SECRET_NEXT,
      }
    : null;

function ensureActiveCredentials(): void {
  if (!activeCredentials.apiKey || !activeCredentials.apiSecret) {
    throw new Error("Pinata credentials are not configured");
  }
}

function setActiveCredentials(credentials: PinataCredentials): void {
  activeCredentials = credentials;
  process.env.PINATA_API_KEY = credentials.apiKey;
  process.env.PINATA_API_SECRET = credentials.apiSecret;
}

async function getPinataClient(): Promise<any> {
  if (stagedCredentials) {
    const valid = await validatePinataCredentials(
      stagedCredentials.apiKey,
      stagedCredentials.apiSecret
    );
    if (valid) {
      setActiveCredentials(stagedCredentials);
      stagedCredentials = null;
      console.info(
        "Pinata credentials rotation: new credentials validated and activated"
      );
    } else if (!activeCredentials.apiKey || !activeCredentials.apiSecret) {
      throw new Error("Pinata credentials are not configured and staged credentials failed validation");
    } else {
      console.warn(
        "Pinata credential rotation: staged credentials failed validation, continuing with active credentials"
      );
    }
  }

  ensureActiveCredentials();
  return new pinataSDK(activeCredentials.apiKey, activeCredentials.apiSecret);
}

export async function validatePinataCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  try {
    const url = `${PINATA_BASE_URL}/data/pinList?status=pinned&limit=1`;
    const response = await fetch(url, {
      headers: {
        pinata_api_key: apiKey,
        pinata_secret_api_key: apiSecret,
      },
      signal: AbortSignal.timeout(CREDENTIAL_VALIDATION_TIMEOUT_MS),
    });

    return response.ok;
  } catch (error) {
    return false;
  }
}

export async function rotatePinataCredentials(
  apiKey: string,
  apiSecret: string
): Promise<void> {
  const valid = await validatePinataCredentials(apiKey, apiSecret);
  if (!valid) {
    throw new Error("Pinata credential validation failed");
  }

  setActiveCredentials({ apiKey, apiSecret });
}

export function getActivePinataCredentials(): PinataCredentials {
  ensureActiveCredentials();
  return { ...activeCredentials };
}

// ---------------------------------------------------------------------------
// Upload-time CID verification config
// ---------------------------------------------------------------------------

// Set IPFS_VERIFY_CID=true to enable content-address integrity checks after upload.
const CID_VERIFY_ENABLED = process.env.IPFS_VERIFY_CID === "true";
const CID_VERIFY_GATEWAY =
  process.env.IPFS_VERIFY_GATEWAY_URL ?? "https://gateway.pinata.cloud/ipfs";

// ---------------------------------------------------------------------------
// Re-pin from trusted gateway
// ---------------------------------------------------------------------------

/**
 * Re-pin a CID from the trusted public IPFS gateway via Pinata's pinByHash API.
 *
 * Called automatically when a CID mismatch is detected on retrieval.
 */
export async function rePinFromGateway(cid: string): Promise<void> {
  const pinata = await getPinataClient();
  await pinata.pinByHash(cid, {
    pinataMetadata: { name: `repin-${cid}` },
  });
  console.info(`[pinata] Successfully re-pinned CID ${cid} from gateway`);
}

// ---------------------------------------------------------------------------
// Upload operations
// ---------------------------------------------------------------------------

export async function uploadImageToIPFS(
  buffer: Buffer,
  filename: string
): Promise<string> {
  return ipfsCircuitBreaker.execute(() =>
    pinataQueue.enqueue(async () => {
      const pinata = await getPinataClient();

      const result = await pinata.pinFileToIPFS(buffer, {
        pinataMetadata: { name: filename },
      });

      const cid = result.IpfsHash;

      if (CID_VERIFY_ENABLED) {
        await verifyCIDContent(buffer, cid, CID_VERIFY_GATEWAY);
      }

      return cid;
    })
  );
}

export async function uploadMetadataToIPFS(metadata: any): Promise<string> {
  return ipfsCircuitBreaker.execute(() =>
    pinataQueue.enqueue(async () => {
      const pinata = await getPinataClient();

      const result = await pinata.pinJSONToIPFS(metadata);
      const cid = result.IpfsHash;

      if (CID_VERIFY_ENABLED) {
        await verifyMetadataCID(metadata, cid, CID_VERIFY_GATEWAY);
      }

      // Cache the metadata
      cache.set(cid, metadata);

      return cid;
    })
  );
}

export async function getMetadataFromIPFS(cid: string): Promise<any> {
  // Check cache first
  const cached = cache.get(cid);
  if (cached) return cached;

  // Fetch via gateway router (primary → secondary → tertiary with failover)
  return ipfsCircuitBreaker.execute(async () => {
    const metadata = await gatewayRouter.fetch(cid);
    cache.set(cid, metadata);
    return metadata;
  });
}

// ---------------------------------------------------------------------------
// Observability helpers
// ---------------------------------------------------------------------------

/**
 * Get the current state of the IPFS circuit breaker (for monitoring/debugging).
 */
export function getIPFSCircuitBreakerMetrics() {
  return ipfsCircuitBreaker.getMetrics();
}

/**
 * Manually reset the IPFS circuit breaker (admin use only).
 */
export function resetIPFSCircuitBreaker(): void {
  ipfsCircuitBreaker.reset();
}

/**
 * Get a snapshot of the Pinata request queue metrics.
 * Useful for observability dashboards and health checks.
 *
 * Returns: { queueDepth, inFlight, throttledCount, retried429Count, avgLatencyMs }
 */
export function getPinataQueueMetrics(): PinataQueueMetrics {
  return pinataQueue.getMetrics();
}

export { CIDMismatchError };
