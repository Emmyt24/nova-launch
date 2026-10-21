import React, { useEffect, useState, useCallback } from 'react';
import { useWallet } from '../../hooks/useWallet';
import { useVaultBalanceSubscription } from '../../hooks/useVaultBalanceSubscription';
import { vaultsApi, fetchCurrentLedger } from '../../services/vaultsApi';
import { VaultCard } from './VaultCard';
import type { VaultProjection } from '../../types';
import { STELLAR_CONFIG } from '../../config/stellar';

export const VaultDashboard: React.FC = () => {
  const { wallet } = useWallet();
  const address = wallet.address;
  const network = wallet.network ?? 'testnet';

  const [vaults, setVaults] = useState<VaultProjection[]>([]);
  const [currentLedger, setCurrentLedger] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) {
      setVaults([]);
      setCurrentLedger(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [fetchedVaults, ledger] = await Promise.all([
        vaultsApi.getByBeneficiary(address),
        fetchCurrentLedger(STELLAR_CONFIG.horizonUrl),
      ]);
      setVaults(fetchedVaults);
      setCurrentLedger(ledger);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vaults');
    } finally {
      setLoading(false);
    }
  }, [address]);

  const handleBalanceChanged = useCallback(
    (vaultId: number, newBalance: string) => {
      setVaults((prev) =>
        prev.map((v) =>
          v.streamId === vaultId ? { ...v, amount: newBalance } : v
        )
      );
    },
    []
  );

  const vaultIds = vaults.map((v) => v.streamId);
  const { isConnected: subscriptionConnected, error: subscriptionError } =
    useVaultBalanceSubscription(vaultIds, handleBalanceChanged);

  useEffect(() => {
    load();
  }, [load]);

  function handleClaimed(streamId: number) {
    setVaults((prev) =>
      prev.map((v) => (v.streamId === streamId ? { ...v, status: 'CLAIMED' } : v)),
    );
  }

  if (!address) {
    return (
      <div className="p-8 text-center" role="status" aria-live="polite">
        <h2 className="text-xl font-semibold mb-4">Vaults Dashboard</h2>
        <p className="text-gray-600">Connect your wallet to view your vesting schedules.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Vaults Dashboard</h1>
          <p className="text-gray-500 mt-1">Your vesting schedules</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition shadow-sm disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {(error || subscriptionError) && (
        <p className="mb-4 text-sm text-red-600" role="alert">
          {error || subscriptionError}
        </p>
      )}

      {subscriptionConnected && (
        <p className="mb-4 text-sm text-green-600" role="status">
          ✓ Real-time balance updates enabled
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {loading ? (
          <div className="lg:col-span-3 p-12 text-center text-gray-500" role="status" aria-live="polite">
            Loading vaults…
          </div>
        ) : vaults.length === 0 ? (
          <div
            className="lg:col-span-3 bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center"
            role="status"
            aria-live="polite"
            aria-label="No vesting vaults"
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-2">
              No vesting vaults found
            </h2>
            <p className="text-gray-500">
              The connected wallet has no vesting schedules. Once a vault is
              created for this address, it will appear here with its unlock
              progress and claim status.
            </p>
          </div>
        ) : (
          vaults.map((vault) => (
            <VaultCard
              key={vault.streamId}
              vault={vault}
              connectedAddress={address}
              currentLedger={currentLedger}
              network={network}
              onClaimed={handleClaimed}
              onFetchWithdrawals={vaultsApi.getWithdrawalHistory}
            />
          ))
        )}
      </div>
    </div>
  );
};
