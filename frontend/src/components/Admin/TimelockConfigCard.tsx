/**
 * TimelockConfigCard
 * Displays timelock configuration and any pending scheduled change.
 * Read-only — clearly labels pending changes and their execution window.
 */
import React from 'react';
import type { TimelockConfig, PendingChange } from '../../types/admin';

interface Props {
  config: TimelockConfig;
  pendingChange: PendingChange | null;
}

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function PendingChangeRow({ change }: { change: PendingChange }) {
  const now = Math.floor(Date.now() / 1000);
  const ready = now >= change.executeAfter;
  const eta = change.executeAfter - now;

  return (
    <div
      className={`rounded-md border px-4 py-3 ${
        ready
          ? 'bg-red-50 border-red-300'
          : 'bg-yellow-50 border-yellow-300'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-gray-800">
          {change.changeType}
        </span>
        {ready ? (
          <span className="text-xs font-medium bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
            🔴 Executable now
          </span>
        ) : (
          <span className="text-xs font-medium bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
            ⏳ Ready in {formatDelay(eta)}
          </span>
        )}
      </div>
      {change.description && (
        <p className="text-xs text-gray-600">{change.description}</p>
      )}
      <p className="text-xs text-gray-400 mt-1">
        Execute after:{' '}
        {new Date(change.executeAfter * 1000).toLocaleString()}
      </p>
      {ready && (
        <p className="text-xs text-red-700 font-medium mt-2">
          ⚠️ This change is ready to execute. Only the admin can trigger execution.
        </p>
      )}
    </div>
  );
}

export function TimelockConfigCard({ config, pendingChange }: Props) {
  return (
    <div className="bg-white rounded-lg shadow-md border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
        <span className="text-lg">⏱️</span>
        <h3 className="text-lg font-semibold text-gray-900">Timelock</h3>
        <span className="ml-auto text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
          Read-only
        </span>
      </div>

      <div className="p-6 space-y-5">
        {/* Delay range */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Min Delay</p>
            <p className="text-xl font-mono font-semibold text-gray-900 mt-0.5">
              {formatDelay(config.minDelay)}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Max Delay</p>
            <p className="text-xl font-mono font-semibold text-gray-900 mt-0.5">
              {formatDelay(config.maxDelay)}
            </p>
          </div>
        </div>

        {/* Pending change */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Pending Change
          </p>
          {pendingChange ? (
            <PendingChangeRow change={pendingChange} />
          ) : (
            <p className="text-sm text-gray-400 italic">No pending changes</p>
          )}
        </div>

        {/* Privileged action notice */}
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 flex gap-2 items-start">
          <span className="text-amber-500 mt-0.5">⚠️</span>
          <p className="text-xs text-amber-800">
            Scheduling, executing, and cancelling changes are privileged operations requiring
            explicit admin confirmation.
          </p>
        </div>
      </div>
    </div>
  );
}
