/**
 * TreasuryPolicyCard
 * Read-only display of treasury policy state: daily cap, withdrawn today,
 * remaining capacity, and the recipient allowlist.
 * No mutating actions — privileged operations are clearly separated.
 */
import React from 'react';
import type { TreasuryPolicy } from '../../types/admin';

interface Props {
  policy: TreasuryPolicy;
}

function stroopsToXlm(stroops: bigint): string {
  return (Number(stroops) / 10_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 7,
  });
}

function CapacityBar({ used, total }: { used: bigint; total: bigint }) {
  const pct = total > 0n ? Math.min(100, Math.round(Number((used * 100n) / total))) : 0;
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="mt-1">
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{stroopsToXlm(used)} XLM used</span>
        <span>{pct}%</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function TreasuryPolicyCard({ policy }: Props) {
  return (
    <div className="bg-white rounded-lg shadow-md border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
        <span className="text-lg">🏦</span>
        <h3 className="text-lg font-semibold text-gray-900">Treasury Policy</h3>
        <span className="ml-auto text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
          Read-only
        </span>
      </div>

      <div className="p-6 space-y-5">
        {/* Daily cap */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Daily Cap</p>
          <p className="text-xl font-mono font-semibold text-gray-900 mt-0.5">
            {stroopsToXlm(policy.dailyCap)} XLM
          </p>
        </div>

        {/* Usage bar */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Today's Usage
          </p>
          <CapacityBar used={policy.withdrawnToday} total={policy.dailyCap} />
          <p className="text-sm text-gray-600 mt-2">
            <span className="font-medium text-green-700">
              {stroopsToXlm(policy.remainingCapacity)} XLM
            </span>{' '}
            remaining today
          </p>
        </div>

        {/* Allowlist */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Allowed Recipients ({policy.allowedRecipients.length})
          </p>
          {policy.allowedRecipients.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No recipients allowlisted</p>
          ) : (
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {policy.allowedRecipients.map((addr) => (
                <li
                  key={addr}
                  className="text-xs font-mono bg-gray-50 border border-gray-200 rounded px-3 py-1.5 text-gray-700 truncate"
                  title={addr}
                >
                  {addr}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Privileged action notice */}
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 flex gap-2 items-start">
          <span className="text-amber-500 mt-0.5">⚠️</span>
          <p className="text-xs text-amber-800">
            Withdrawals and allowlist changes are privileged operations. They require admin
            authentication and are subject to the timelock delay.
          </p>
        </div>
      </div>
    </div>
  );
}
