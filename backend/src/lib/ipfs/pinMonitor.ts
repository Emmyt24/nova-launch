/**
 * IPFS pin-status monitor (#1158).
 *
 * Responsibilities:
 *  1. Verify a pin succeeded immediately after upload (verifyPin).
 *  2. Periodically check that tracked CIDs remain pinned (startMonitor).
 *  3. Emit an alert (via the onUnpinned callback) when content is not pinned.
 *
 * Check interval: controlled by PIN_MONITOR_INTERVAL_MS env var (default 5 min).
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PINATA_GATEWAY = "https://api.pinata.cloud";

export interface PinStatusResult {
  cid: string;
  pinned: boolean;
  error?: string;
}

export type UnpinnedAlertHandler = (cid: string, error?: string) => void;

/**
 * Check whether a single CID is currently pinned via the Pinata API.
 *
 * Performs an exact-match check to avoid false positives from substring matches
 * where another pinned CID's hash contains the target CID as a substring.
 */
export async function checkPinStatus(
  cid: string,
  apiKey: string,
  apiSecret: string
): Promise<PinStatusResult> {
  try {
    const url = `${PINATA_GATEWAY}/data/pinList?hashContains=${encodeURIComponent(cid)}&status=pinned`;
    const res = await fetch(url, {
      headers: {
        pinata_api_key: apiKey,
        pinata_secret_api_key: apiSecret,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { cid, pinned: false, error: `Pinata API error: HTTP ${res.status}` };
    }

    const data = (await res.json()) as {
      count: number;
      rows?: Array<{ ipfs_pin_hash: string }>;
    };

    // Verify exact CID match: the substring query may return false positives,
    // so check that at least one returned row has an exact match
    if (data.rows && data.rows.length > 0) {
      const exactMatch = data.rows.some((row) => row.ipfs_pin_hash === cid);
      return { cid, pinned: exactMatch };
    }

    return { cid, pinned: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { cid, pinned: false, error };
  }
}

/**
 * Verify that a CID is pinned immediately after upload.
 * Throws if the pin cannot be confirmed.
 */
export async function verifyPin(
  cid: string,
  apiKey: string,
  apiSecret: string
): Promise<void> {
  const result = await checkPinStatus(cid, apiKey, apiSecret);
  if (!result.pinned) {
    throw new Error(
      `Pin verification failed for CID ${cid}${result.error ? `: ${result.error}` : ""}`
    );
  }
}

/**
 * Start a periodic monitor that checks all tracked CIDs and calls
 * onUnpinned for any that are no longer pinned.
 *
 * @param cids         Set of CIDs to monitor (mutated externally to add/remove)
 * @param apiKey       Pinata API key
 * @param apiSecret    Pinata API secret
 * @param onUnpinned   Alert handler called when a CID is found unpinned
 * @param intervalMs   Check interval in milliseconds (default: 5 min)
 * @returns            A stop function that cancels the monitor
 */
export function startPinMonitor(
  cids: Set<string>,
  apiKey: string,
  apiSecret: string,
  onUnpinned: UnpinnedAlertHandler,
  intervalMs: number = parseInt(
    process.env.PIN_MONITOR_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
    10
  )
): () => void {
  const timer = setInterval(async () => {
    for (const cid of cids) {
      const result = await checkPinStatus(cid, apiKey, apiSecret);
      if (!result.pinned) {
        onUnpinned(cid, result.error);
      }
    }
  }, intervalMs);

  // Allow the process to exit even if the timer is still running
  if (timer.unref) timer.unref();

  return () => clearInterval(timer);
}
