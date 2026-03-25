/**
 * FactoryAdminPanel
 * Aggregates admin, treasury, and timelock state into a single read-only panel.
 * All data is fetched via direct contract simulation — no backend required.
 *
 * Privileged actions (transfer admin, withdraw fees, execute changes) are
 * clearly labelled and separated from the read-only state display.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StellarService } from '../../services/stellar.service';
import { TreasuryPolicyCard } from './TreasuryPolicyCard';
import { TimelockConfigCard } from './TimelockConfigCard';
import type { AdminPanelLoadState, AdminPanelState } from '../../types/admin';

interface Props {
  network?: 'testnet' | 'mainnet';
  /** Called when the user clicks a privileged action button — caller handles auth/confirmation */
  onPrivilegedAction?: (action: 'transfer_admin' | 'withdraw_fees' | 'execute_change' | 'cancel_change') => void;
}

function stroopsToXlm(stroops: bigint): string {
  return (Number(stroops) / 10_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 7,
  });
}

function AddressRow({ label, value, warning }: { label: string; value: string; warning?: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p
        className="text-sm font-mono break-all text-gray-900 mt-0.5 bg-gray-50 border border-gray-200 rounded px-3 py-2"
        title={value}
      >
        {value || <span className="text-gray-400 italic">—</span>}
      </p>
      {warning && (
        <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
          <span>🔴</span> {warning}
        </p>
      )}
    </div>
  );
}

function AdminStateCard({
  state,
  onPrivilegedAction,
}: {
  state: AdminPanelState['adminState'];
  onPrivilegedAction?: Props['onPrivilegedAction'];
}) {
  return (
    <div className="bg-white rounded-lg shadow-md border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
        <span className="text-lg">🔑</span>
        <h3 className="text-lg font-semibold text-gray-900">Factory Admin</h3>
        {state.paused && (
          <span className="ml-2 text-xs font-semibold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
            🔴 PAUSED
          </span>
        )}
        <span className="ml-auto text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
          Read-only
        </span>
      </div>

      <div className="p-6 space-y-4">
        <AddressRow label="Current Admin" value={state.admin} />

        <AddressRow
          label="Proposed Admin"
          value={state.proposedAdmin ?? ''}
          warning={
            state.proposedAdmin
              ? 'Admin transfer is pending. The proposed address must call accept_admin to complete the transfer.'
              : undefined
          }
        />

        <AddressRow label="Treasury" value={state.treasury} />

        {/* Fees */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Base Fee</p>
            <p className="text-lg font-mono font-semibold text-gray-900 mt-0.5">
              {stroopsToXlm(state.baseFee)} XLM
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Metadata Fee</p>
            <p className="text-lg font-mono font-semibold text-gray-900 mt-0.5">
              {stroopsToXlm(state.metadataFee)} XLM
            </p>
          </div>
        </div>

        {/* Contract status */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Contract Status</p>
          <p className={`text-sm font-semibold mt-0.5 ${state.paused ? 'text-red-600' : 'text-green-600'}`}>
            {state.paused ? '🔴 Paused — token creation is disabled' : '🟢 Active'}
          </p>
        </div>

        {/* Privileged actions — clearly separated */}
        {onPrivilegedAction && (
          <div className="pt-4 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Privileged Actions
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onPrivilegedAction('transfer_admin')}
                className="text-xs px-3 py-1.5 rounded border border-orange-300 text-orange-700 bg-orange-50 hover:bg-orange-100 font-medium transition-colors"
              >
                Transfer Admin
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              These actions require wallet authentication and cannot be undone without a timelock delay.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingPanel() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-lg shadow-md border border-gray-200 p-6 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3 mb-4" />
          <div className="space-y-3">
            <div className="h-3 bg-gray-100 rounded w-full" />
            <div className="h-3 bg-gray-100 rounded w-3/4" />
            <div className="h-3 bg-gray-100 rounded w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function FactoryAdminPanel({ network = 'testnet', onPrivilegedAction }: Props) {
  const [loadState, setLoadState] = useState<AdminPanelLoadState>({ status: 'idle' });

  const load = useCallback(async () => {
    setLoadState({ status: 'loading' });
    try {
      const service = new StellarService(network);
      const [adminState, treasuryPolicy, timelockConfig, pendingChange] = await Promise.allSettled([
        service.getAdminState(),
        service.getTreasuryPolicy(),
        service.getTimelockConfig(),
        service.getPendingChange(),
      ]);

      if (adminState.status === 'rejected') {
        throw new Error(adminState.reason instanceof Error ? adminState.reason.message : 'Failed to load admin state');
      }

      const data: AdminPanelState = {
        adminState: adminState.value,
        treasuryPolicy: treasuryPolicy.status === 'fulfilled' ? treasuryPolicy.value : null,
        timelockConfig: timelockConfig.status === 'fulfilled' ? timelockConfig.value : null,
        pendingChange: pendingChange.status === 'fulfilled' ? pendingChange.value : null,
        loadedAt: Date.now(),
      };

      setLoadState({ status: 'loaded', data });
    } catch (err) {
      setLoadState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown error loading admin state',
      });
    }
  }, [network]);

  // Reload when network changes
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Factory Admin Panel</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Live contract state on{' '}
            <span className="font-medium text-gray-700 capitalize">{network}</span>
          </p>
        </div>
        <button
          onClick={load}
          disabled={loadState.status === 'loading'}
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {loadState.status === 'loading' ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading…
            </>
          ) : (
            <>↻ Refresh</>
          )}
        </button>
      </div>

      {/* Last loaded timestamp */}
      {loadState.status === 'loaded' && (
        <p className="text-xs text-gray-400">
          Last loaded: {new Date(loadState.data.loadedAt).toLocaleTimeString()}
        </p>
      )}

      {/* States */}
      {loadState.status === 'idle' && (
        <p className="text-sm text-gray-400">Click Refresh to load contract state.</p>
      )}

      {loadState.status === 'loading' && <LoadingPanel />}

      {loadState.status === 'error' && (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-5 py-4 flex items-start gap-3"
        >
          <span className="text-red-500 text-lg">⚠️</span>
          <div>
            <p className="text-sm font-semibold text-red-800">Failed to load admin state</p>
            <p className="text-xs text-red-600 mt-1">{loadState.message}</p>
            <button
              onClick={load}
              className="mt-2 text-xs text-red-700 underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {loadState.status === 'loaded' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <AdminStateCard
            state={loadState.data.adminState}
            onPrivilegedAction={onPrivilegedAction}
          />

          {loadState.data.treasuryPolicy ? (
            <TreasuryPolicyCard policy={loadState.data.treasuryPolicy} />
          ) : (
            <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
              <p className="text-sm text-gray-400 italic">Treasury policy not available</p>
            </div>
          )}

          {loadState.data.timelockConfig && (
            <div className="md:col-span-2">
              <TimelockConfigCard
                config={loadState.data.timelockConfig}
                pendingChange={loadState.data.pendingChange}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
