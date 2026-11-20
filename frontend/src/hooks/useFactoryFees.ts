import { useState, useEffect, useCallback } from 'react';
import { StellarService } from '../services/stellar.service';
import { FALLBACK_BASE_FEE, FALLBACK_METADATA_FEE } from '../utils/feeCalculation';

interface FactoryFees {
    baseFee: number;
    metadataFee: number;
}

interface UseFactoryFeesResult extends FactoryFees {
    loading: boolean;
    error: string | null;
    isFallback: boolean;
    refresh: () => void;
}

/** Cache keyed by network, expires after 60 s */
const cache = new Map<string, { fees: FactoryFees; expiresAt: number }>();
const TTL_MS = 60_000;

/** Exposed for testing only */
export function _clearFeesCache() { cache.clear(); }

export function useFactoryFees(network: 'testnet' | 'mainnet'): UseFactoryFeesResult {
    const [fees, setFees] = useState<FactoryFees>({ baseFee: FALLBACK_BASE_FEE, metadataFee: FALLBACK_METADATA_FEE });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isFallback, setIsFallback] = useState(false);
    const [refreshCount, setRefreshCount] = useState(0);

    const refresh = useCallback(() => {
        cache.delete(network);
        setRefreshCount(c => c + 1);
    }, [network]);

    useEffect(() => {
        let cancelled = false;

        const cached = cache.get(network);
        if (cached && Date.now() < cached.expiresAt) {
            setFees(cached.fees);
            setLoading(false);
            setError(null);
            setIsFallback(false);
            return;
        }

        setLoading(true);
        setError(null);

        new StellarService(network).getContractFees()
            .then((result) => {
                if (cancelled) return;
                cache.set(network, { fees: result, expiresAt: Date.now() + TTL_MS });
                setFees(result);
                setIsFallback(false);
                setError(null);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setFees({ baseFee: FALLBACK_BASE_FEE, metadataFee: FALLBACK_METADATA_FEE });
                setIsFallback(true);
                setError(err instanceof Error ? err.message : 'Failed to read fees from contract');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => { cancelled = true; };
    }, [network, refreshCount]);

    return { ...fees, loading, error, isFallback, refresh };
}
