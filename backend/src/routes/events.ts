/**
 * GET /api/events/catchup?since=<sequence>
 *
 * Returns events from the shared EventBus history that have a sequence
 * number greater than `since`, ordered ascending.
 *
 * If the gap (currentSequence - since) exceeds CATCHUP_LIMIT (1000), returns
 * { truncated: true, currentSequence } to tell the client to do a full REST
 * refresh instead (#1372).
 */

import { Router, Request, Response } from "express";
import { eventBus } from "../services/eventBus";
import {
  detectExplorerLinkType,
  getExplorerUrl,
  type ExplorerLinkType,
  type ExplorerProvider,
  type StellarNetwork,
} from "../config/explorer";

export const CATCHUP_LIMIT = 1000;

const VALID_NETWORKS: readonly StellarNetwork[] = ["mainnet", "testnet", "futurenet"];
const VALID_PROVIDERS: readonly ExplorerProvider[] = ["stellar.expert", "stellarchain"];

function resolveNetwork(): StellarNetwork {
  const raw = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  return (VALID_NETWORKS as readonly string[]).includes(raw)
    ? (raw as StellarNetwork)
    : "testnet";
}

function resolveProvider(): ExplorerProvider {
  const raw = (process.env.EXPLORER_PROVIDER ?? "stellar.expert").toLowerCase();
  return (VALID_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as ExplorerProvider)
    : "stellar.expert";
}

/**
 * Attach an `explorerUrl` to an event when it carries a transaction hash or a
 * contract/account identifier. Returns the event unchanged when no linkable
 * identifier is present.
 */
function withExplorerUrl<T extends Record<string, unknown>>(
  event: T,
  network: StellarNetwork,
  provider: ExplorerProvider,
): T & { explorerUrl?: string } {
  const candidates: Array<{ type: ExplorerLinkType; value: unknown }> = [
    { type: "tx", value: event.txHash ?? event.transactionHash },
    { type: "contract", value: event.contractId },
    { type: "account", value: event.accountId ?? event.address },
  ];

  for (const { type, value } of candidates) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (detectExplorerLinkType(value) !== type) continue;
    return { ...event, explorerUrl: getExplorerUrl(type, value, { network, provider }) };
  }

  return event;
}

const router = Router();

router.get("/catchup", (req: Request, res: Response) => {
  const sinceRaw = req.query.since;
  const since = sinceRaw !== undefined ? parseInt(String(sinceRaw), 10) : NaN;

  if (isNaN(since) || since < 0) {
    res.status(400).json({ error: "Query parameter 'since' must be a non-negative integer" });
    return;
  }

  const currentSequence = eventBus.currentSequence;

  // The in-memory event bus resets its sequence after a process restart. A
  // client cursor ahead of the new sequence is therefore stale and requires
  // a full resync rather than an empty successful catch-up response.
  if (since > currentSequence) {
    res.json({ truncated: true, reason: "cursor_reset", currentSequence });
    return;
  }

  // Truncation guard — tell client to do a full refresh
  if (currentSequence - since > CATCHUP_LIMIT) {
    res.json({ truncated: true, currentSequence });
    return;
  }

  const network = resolveNetwork();
  const provider = resolveProvider();

  const missed = eventBus
    .getHistory()
    .filter((e) => e.sequence > since)
    .sort((a, b) => a.sequence - b.sequence)
    .map((e) => withExplorerUrl(e as unknown as Record<string, unknown>, network, provider));

  res.json({ truncated: false, events: missed, currentSequence });
});

export default router;
