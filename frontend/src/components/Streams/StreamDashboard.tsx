/**
 * Stream dashboard for the payment-streaming/vesting feature (Issue #1765).
 * Distinct from `Vaults/VaultDashboard.tsx` — a new, parallel component.
 */
import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '../../hooks/useWallet';
import { streamsApi } from '../../services/streamsApi';
import { claimStream, getStream } from '../../hooks/useStreamContract';
import type { PaymentStreamMetadata, PaymentStreamOnChain } from '../../types';

interface Row {
  meta: PaymentStreamMetadata;
  onChain: PaymentStreamOnChain | null;
}

export default function StreamDashboard() {
  const { wallet } = useWallet();
  const address = wallet.address;
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const metas = await streamsApi.getByRecipient(address);
      const onChain = await Promise.all(metas.map((m) => getStream(m.streamId).catch(() => null)));
      setRows(metas.map((meta, i) => ({ meta, onChain: onChain[i] })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load streams');
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    load();
  }, [load]);

  const handleClaim = async (streamId: string) => {
    if (!address) return;
    setClaimingId(streamId);
    try {
      await claimStream(streamId, address, wallet.network as 'testnet' | 'mainnet');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Claim failed');
    } finally {
      setClaimingId(null);
    }
  };

  if (!address) {
    return (
      <div role="status" className="p-6 text-center text-gray-500">
        Connect your wallet to view your payment streams.
      </div>
    );
  }

  if (loading) {
    return (
      <div role="status" aria-live="polite" className="p-6 text-center text-gray-500">
        Loading streams…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500 border border-dashed rounded-xl">
        No payment streams found for this address.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {error && (
        <p role="alert" className="lg:col-span-3 text-red-600">
          {error}
        </p>
      )}
      {rows.map(({ meta, onChain }) => {
        const total = onChain ? BigInt(onChain.totalAmount) : 0n;
        const claimed = onChain ? BigInt(onChain.claimedAmount) : 0n;
        const remaining = total - claimed;
        return (
          <div key={meta.streamId} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <h3 className="font-semibold">{meta.title || `Stream #${meta.streamId}`}</h3>
            {meta.description && <p className="text-sm text-gray-500">{meta.description}</p>}
            <p className="text-sm mt-2">
              Claimed {claimed.toString()} / {total.toString()}
            </p>
            <button
              type="button"
              disabled={claimingId === meta.streamId || !onChain || onChain.cancelled || remaining <= 0n}
              aria-disabled={claimingId === meta.streamId}
              onClick={() => handleClaim(meta.streamId)}
              className="mt-3 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-50"
            >
              {claimingId === meta.streamId ? 'Claiming…' : 'Claim'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
