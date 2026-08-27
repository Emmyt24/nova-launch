import { useState, useEffect, useCallback, useRef } from 'react';
import { analytics, AnalyticsEvent } from '../services/analytics';
import { ACTIVE_NETWORK, STELLAR_CONFIG } from '../config/stellar';
import { checkNetworkContractMismatch } from '../utils/validation';
import {
    StellarWalletsKit,
    initWalletKit,
    setKitNetwork,
    WALLET_ID_MAP,
} from '../services/walletKit';
import { WalletService } from '../services/wallet';
import type { WalletState, WalletType } from '../types';
import { authSyncService } from '../services/authSync.service';

export const WALLET_CONNECTED_KEY = 'nova_wallet_connected';
export const WALLET_STATE_KEY = 'nova_wallet_state';
export const WALLET_TYPE_KEY = 'nova_wallet_type';

interface PersistedWalletState {
    address: string;
    network: 'testnet' | 'mainnet';
    walletType?: WalletType;
}

function loadPersistedWalletState(): PersistedWalletState | null {
    try {
        const raw = localStorage.getItem(WALLET_STATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PersistedWalletState;
        if (!parsed.address || !parsed.network) return null;
        return parsed;
    } catch {
        return null;
    }
}

function saveWalletState(address: string, network: 'testnet' | 'mainnet', walletType?: WalletType): void {
    localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
    localStorage.setItem(WALLET_STATE_KEY, JSON.stringify({ address, network, walletType }));
    if (walletType) localStorage.setItem(WALLET_TYPE_KEY, walletType);
}

function clearWalletState(): void {
    localStorage.removeItem(WALLET_CONNECTED_KEY);
    localStorage.removeItem(WALLET_STATE_KEY);
    localStorage.removeItem(WALLET_TYPE_KEY);
}

interface UseWalletOptions {
    network?: 'testnet' | 'mainnet';
}

export const useWallet = (options: UseWalletOptions = {}) => {
    const { network: externalNetwork = 'testnet' } = options;
    const [wallet, setWallet] = useState<WalletState>({
        connected: false,
        address: null,
        network: externalNetwork,
    });
    const [isConnecting, setIsConnecting] = useState(false);
    const [isSelectorOpen, setIsSelectorOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [networkMismatchWarning, setNetworkMismatchWarning] = useState<string | null>(null);
    const isInitializedRef = useRef(false);
    const prevNetworkRef = useRef(externalNetwork);

    // Initialise the kit once on mount
    useEffect(() => {
        initWalletKit(externalNetwork);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const disconnect = useCallback(async () => {
        try {
            await StellarWalletsKit.disconnect();
        } catch {}

        setWallet((prev) => ({
            connected: false,
            address: null,
            network: prev.network,
            walletType: undefined,
        }));
        setError(null);
        clearWalletState();

        // Invalidate server-side JWT session (#1371)
        void authSyncService.onDisconnect();

        try {
            analytics.track(AnalyticsEvent.WALLET_DISCONNECTED);
        } catch {}
    }, []);

    // Sync network changes
    useEffect(() => {
        if (prevNetworkRef.current !== externalNetwork) {
            prevNetworkRef.current = externalNetwork;
            setKitNetwork(externalNetwork);
            if (wallet.connected) {
                void disconnect();
            }
            setWallet((prev) => ({ ...prev, network: externalNetwork }));
        }
    }, [externalNetwork, wallet.connected, disconnect]);

    const resolveNetworkFromPassphrase = (passphrase: string): 'testnet' | 'mainnet' => {
        return passphrase.toLowerCase().includes('test') ? 'testnet' : 'mainnet';
    };

    const updateWalletState = useCallback(
        async (walletType?: WalletType): Promise<boolean> => {
            try {
                const { address } = await StellarWalletsKit.getAddress();
                if (!address) {
                    await disconnect();
                    return false;
                }

                let network: 'testnet' | 'mainnet' = externalNetwork;
                try {
                    const { networkPassphrase } = await StellarWalletsKit.getNetwork();
                    network = resolveNetworkFromPassphrase(networkPassphrase);
                } catch {}

                const type = walletType ?? (loadPersistedWalletState()?.walletType);
                setWallet({ connected: true, address, network, walletType: type });
                saveWalletState(address, network, type);

                const { mismatch, message } = checkNetworkContractMismatch(
                    STELLAR_CONFIG.factoryContractId,
                    network,
                    ACTIVE_NETWORK
                );
                setNetworkMismatchWarning(mismatch ? (message ?? null) : null);

                try {
                    analytics.track(AnalyticsEvent.WALLET_CONNECTED, { network, walletType: type ?? 'unknown' });
                } catch {}

                return true;
            } catch {
                await disconnect();
                return false;
            }
        },
        [disconnect, externalNetwork]
    );

    /** Open the wallet selector modal */
    const openSelector = useCallback(() => {
        setError(null);
        setIsSelectorOpen(true);
    }, []);

    const closeSelector = useCallback(() => {
        setIsSelectorOpen(false);
    }, []);

    /**
     * Called when the user picks a wallet from the selector.
     * If the wallet is not installed, the caller should open the install URL instead.
     */
    const connectWithWallet = useCallback(
        async (walletId: string, walletType: WalletType) => {
            setIsConnecting(true);
            setError(null);

            try {
                StellarWalletsKit.setWallet(walletId);
                const { address } = await StellarWalletsKit.fetchAddress();
                if (!address) throw new Error('No address returned from wallet');

                let network: 'testnet' | 'mainnet' = externalNetwork;
                try {
                    const { networkPassphrase } = await StellarWalletsKit.getNetwork();
                    network = resolveNetworkFromPassphrase(networkPassphrase);
                } catch {}

                setWallet({ connected: true, address, network, walletType });
                saveWalletState(address, network, walletType);

                const { mismatch, message } = checkNetworkContractMismatch(
                    STELLAR_CONFIG.factoryContractId,
                    network,
                    ACTIVE_NETWORK
                );
                setNetworkMismatchWarning(mismatch ? (message ?? null) : null);

                try {
                    analytics.track(AnalyticsEvent.WALLET_CONNECTED, { network, walletType });
                } catch {}

                setIsSelectorOpen(false);
            } catch (err: any) {
                setError(err?.message ?? 'Failed to connect wallet');
            } finally {
                setIsConnecting(false);
            }
        },
        [externalNetwork]
    );

    /** Legacy direct-connect (falls back to Freighter for backwards compat) */
    const connect = useCallback(async () => {
        setIsConnecting(true);
        setError(null);

        try {
            const freighterId = WALLET_ID_MAP['freighter'];
            StellarWalletsKit.setWallet(freighterId);

            // Freighter check via original WalletService (keeps existing UX for non-selector flow)
            const isInstalled = await WalletService.isInstalled();
            if (!isInstalled) {
                throw new Error('Freighter wallet is not installed');
            }

            const { address } = await StellarWalletsKit.fetchAddress();
            if (!address) throw new Error('User rejected connection or account not found');

            const success = await updateWalletState('freighter');
            if (!success) throw new Error('User rejected connection or account not found');

            try {
                analytics.track('wallet_connect_initiated', { method: 'freighter' });
            } catch {}
        } catch (err: any) {
            setError(err.message || 'Failed to connect wallet');
        } finally {
            setIsConnecting(false);
        }
    }, [updateWalletState]);

    // Auto-reconnect on mount from persisted state
    useEffect(() => {
        if (isInitializedRef.current) return;
        isInitializedRef.current = true;

        const wasConnected = localStorage.getItem(WALLET_CONNECTED_KEY) === 'true';
        if (!wasConnected) return;

        const persisted = loadPersistedWalletState();
        if (persisted) {
            setWallet({
                connected: true,
                address: persisted.address,
                network: persisted.network,
                walletType: persisted.walletType,
            });
        }

        (async () => {
            if (persisted?.walletType) {
                const id = WALLET_ID_MAP[persisted.walletType];
                if (id) StellarWalletsKit.setWallet(id);
            }

            const success = await updateWalletState(persisted?.walletType);
            if (!success) {
                clearWalletState();
            }
        })();
    }, [updateWalletState]);

    return {
        wallet,
        connect,
        connectWithWallet,
        openSelector,
        closeSelector,
        isSelectorOpen,
        disconnect,
        isConnecting,
        error,
        networkMismatchWarning,
    };
};
