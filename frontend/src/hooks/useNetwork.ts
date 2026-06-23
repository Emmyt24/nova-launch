import { useState, useCallback, useEffect } from 'react';
import { setApiNetwork } from '../services/apiClient';
import { invalidateLeaderboardCache } from '../services/leaderboardApi';
import { transactionHistoryStorage } from '../services/TransactionHistoryStorage';

type Network = 'testnet' | 'mainnet';

const NETWORK_STORAGE_KEY = 'nova_network_preference';

function getStoredNetwork(): Network {
    try {
        const stored = localStorage.getItem(NETWORK_STORAGE_KEY);
        if (stored === 'mainnet' || stored === 'testnet') {
            return stored;
        }
    } catch {
        // localStorage may be unavailable
    }
    return 'testnet';
}

/**
 * Clear every cache that holds data scoped to a specific network, so
 * switching testnet/mainnet never leaks the previous network's token list,
 * leaderboard rankings, or transaction history into the new network's UI.
 */
function clearNetworkScopedCaches(): void {
    invalidateLeaderboardCache();
    transactionHistoryStorage.clearAll();
}

export function useNetwork() {
    const [network, setNetworkState] = useState<Network>(getStoredNetwork);
    const [isChanging, setIsChanging] = useState(false);

    useEffect(() => {
        try {
            localStorage.setItem(NETWORK_STORAGE_KEY, network);
        } catch {
            // localStorage may be unavailable
        }
        setApiNetwork(network);
    }, [network]);

    const setNetwork = useCallback((newNetwork: Network) => {
        setIsChanging(true);
        setNetworkState((prev) => {
            if (prev !== newNetwork) {
                clearNetworkScopedCaches();
            }
            return newNetwork;
        });
        setTimeout(() => setIsChanging(false), 300);
    }, []);

    const toggleNetwork = useCallback(() => {
        setNetwork(network === 'testnet' ? 'mainnet' : 'testnet');
    }, [network, setNetwork]);

    return {
        network,
        setNetwork,
        toggleNetwork,
        isTestnet: network === 'testnet',
        isMainnet: network === 'mainnet',
        isChanging,
    };
}
