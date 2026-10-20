import React, { useState } from 'react';
import type { VaultProjection } from '../../types';
import { claimVault } from '../../hooks/useVaultContract';
import { useToast } from '../../hooks/useToast';
import { useConfetti } from '../../hooks/useConfetti';
import { WithdrawalHistory } from './WithdrawalHistory';
import type { PaginatedWithdrawals } from '../../services/vaultsApi';
import { computeVestingProgress } from '../../utils/vestingProgress';

interface VaultCardProps {
  vault: VaultProjection;
  connectedAddress: string | null;
  currentLedger: number;
  network?: 'testnet' | 'mainnet';
  onClaimed?: (streamId: number) => void;
  onFetchWithdrawals?: (vaultId: number, cursor?: string) => Promise<PaginatedWithdrawals>;
}

function truncate(addr: string, chars = 6): string {
  return addr.length <= chars * 2 ? addr : `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

const STATUS_STYLES: Record<string, string> = {
  CREATED: 'bg-blue-100 text-blue-700',
  CLAIMED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-700',
};

export const VaultCard: React.FC<VaultCardProps> = ({
  vault,
  connectedAddress,
  currentLedger,
  network = 'testnet',
  onClaimed,
  onFetchWithdrawals,
}) => {
  const [claiming, setClaiming] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const toast = useToast();
  const { fire: fireConfetti } = useConfetti();

  const progress = computeVestingProgress(
    currentLedger,
    vault.startLedger,
    vault.endLedger,
  );
  const isMatured = progress >= 100;
  const isBeneficiary =
    connectedAddress != null &&
    vault.recipient.toLowerCase() === connectedAddress.toLowerCase();
  const canClaim =
    isBeneficiary && isMatured && vault.status === 'CREATED' && !claiming;

  async function handleClaim() {
    if (!connectedAddress) return;
    setClaiming(true);
    try {
      await claimVault(vault.streamId, connectedAddress, network);
      fireConfetti();
      toast.success('Vault claimed successfully!');
      onClaimed?.(vault.streamId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Claim failed');
    } finally {
      setClaiming(false);
    }
  }

  const statusLabel = vault.status === 'CLAIMED' ? 'Claimed' : vault.status === 'CANCELLED' ? 'Cancelled' : isMatured ? 'Matured' : 'Vesting';
  const statusStyle = vault.status === 'CLAIMED'
    ? STATUS_STYLES.CLAIMED
    : vault.status === 'CANCELLED'
    ? STATUS_STYLES.CANCELLED
    : isMatured
    ? 'bg-amber-100 text-amber-700'
    : STATUS_STYLES.CREATED;

  return (
    <article
      className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
      aria-label={`Vault #${vault.streamId}`}
    >
      {!showHistory ? (
        <div className="p-5 space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <span
                className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${statusStyle}`}
              >
                {statusLabel}
              </span>
              <p className="mt-1 text-xs text-gray-400">Stream #{vault.streamId}</p>
            </div>
            <p className="text-lg font-bold text-gray-900">{vault.amount}</p>
          </div>

          {/* Details */}
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Creator</dt>
              <dd className="font-mono text-gray-800">{truncate(vault.creator)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Recipient</dt>
              <dd className="font-mono text-gray-800">{truncate(vault.recipient)}</dd>
            </div>
            {vault.startLedger != null && vault.endLedger != null && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Ledgers</dt>
                <dd className="text-gray-800">
                  {vault.startLedger} → {vault.endLedger}
                </dd>
              </div>
            )}
          </dl>

          {/* Progress bar */}
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Vesting progress</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div
              className="h-2 w-full bg-gray-100 rounded-full overflow-hidden"
              role="progressbar"
              aria-valuenow={Math.round(progress)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Vesting progress"
            >
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  isMatured ? 'bg-green-500' : 'bg-blue-500'
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Claim button */}
          {vault.status === 'CREATED' && (
            <button
              type="button"
              onClick={handleClaim}
              disabled={!canClaim}
              aria-disabled={!canClaim}
              className={`w-full py-2 rounded-lg text-sm font-bold transition ${
                canClaim
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              {claiming
                ? 'Claiming…'
                : !isBeneficiary
                ? 'Not your vault'
                : !isMatured
                ? 'Not yet vested'
                : 'Claim'}
            </button>
          )}

          {/* View history button */}
          {onFetchWithdrawals && (
            <button
              type="button"
              onClick={() => setShowHistory(true)}
              className="w-full py-2 rounded-lg text-sm font-bold text-blue-600 hover:bg-blue-50 transition border border-blue-200"
            >
              View Withdrawal History
            </button>
          )}
        </div>
      ) : (
        <div className="p-5 space-y-4">
          {/* History header */}
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-gray-900">Withdrawal History</h3>
            <button
              type="button"
              onClick={() => setShowHistory(false)}
              className="text-gray-400 hover:text-gray-600 text-xl"
              aria-label="Close history"
            >
              ×
            </button>
          </div>

          {/* Withdrawal history */}
          {onFetchWithdrawals && (
            <WithdrawalHistory
              vaultId={vault.streamId}
              onFetchWithdrawals={onFetchWithdrawals}
            />
          )}
        </div>
      )}
    </article>
  );
};
