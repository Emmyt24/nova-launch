import { useState } from 'react';
import { Card } from '../UI/Card';
import { Button } from '../UI/Button';
import {
    truncateAddress,
    formatTokenSupply,
    formatBurnStats,
} from '../../utils/formatting';
import type { TokenInfo } from '../../types';

/**
 * Extended token info with indexed metadata from backend
 */
export interface IndexedTokenCardData extends TokenInfo {
    initialSupply?: string;
    totalBurned?: string;
    burnCount?: number;
}

interface TokenCardProps {
    token: IndexedTokenCardData;
    network: 'testnet' | 'mainnet';
}

export function TokenCard({ token, network }: TokenCardProps) {
    const [copied, setCopied] = useState(false);

    const explorerUrl = network === 'testnet'
        ? `https://stellar.expert/explorer/testnet/contract/${token.address}`
        : `https://stellar.expert/explorer/public/contract/${token.address}`;

    const txUrl = token.transactionHash
        ? network === 'testnet'
            ? `https://stellar.expert/explorer/testnet/tx/${token.transactionHash}`
            : `https://stellar.expert/explorer/public/tx/${token.transactionHash}`
        : null;

    const handleCopy = async () => {
        await navigator.clipboard.writeText(token.address);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const deployDate = new Date(token.deployedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });

    const hasBurnData = token.totalBurned !== undefined && token.initialSupply !== undefined;
    const burnStats = hasBurnData
        ? formatBurnStats(
              token.totalBurned!,
              token.burnCount || 0,
              token.initialSupply!,
              token.decimals
          )
        : null;

    const hasBurns = hasBurnData && token.burnCount && token.burnCount > 0;

    return (
        <Card className="hover:shadow-lg transition-shadow">
            <div className="space-y-4">
                {token.metadataUri && (
                    <img
                        src={token.metadataUri}
                        alt={token.name}
                        className="w-full h-32 object-cover rounded-md"
                        onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                        }}
                    />
                )}

                <div>
                    <h3 className="text-xl font-bold text-gray-900">{token.name}</h3>
                    <p className="text-sm text-gray-500">{token.symbol}</p>
                </div>

                <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                        <span className="text-gray-600">Address:</span>
                        <div className="flex items-center gap-2">
                            <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                                {truncateAddress(token.address)}
                            </code>
                            <button
                                onClick={handleCopy}
                                className="text-blue-600 hover:text-blue-700"
                                title="Copy address"
                            >
                                {copied ? '✓' : '📋'}
                            </button>
                        </div>
                    </div>

                    <div className="flex items-center justify-between">
                        <span className="text-gray-600">Supply:</span>
                        <span className="text-gray-900 font-mono">
                            {formatTokenSupply(token.totalSupply, token.decimals, { compact: true })}
                        </span>
                    </div>

                    {hasBurns && burnStats && (
                        <div className="flex items-center justify-between">
                            <span className="text-gray-600">Burned:</span>
                            <div className="flex items-center gap-2">
                                <span className="text-orange-600 font-mono">
                                    {burnStats.burnedAmount}
                                </span>
                                <span className="text-xs text-gray-500">
                                    ({burnStats.percentage})
                                </span>
                            </div>
                        </div>
                    )}

                    <div className="flex items-center justify-between">
                        <span className="text-gray-600">Deployed:</span>
                        <span className="text-gray-900">{deployDate}</span>
                    </div>
                </div>

                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => window.open(explorerUrl, '_blank')}
                    >
                        View Token
                    </Button>
                    {txUrl && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            onClick={() => window.open(txUrl, '_blank')}
                        >
                            View TX
                        </Button>
                    )}
                </div>
            </div>
        </Card>
    );
}
