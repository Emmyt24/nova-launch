import {
    isConnected,
    getAddress,
    getNetwork,
    signTransaction,
    WatchWalletChanges,
    requestAccess,
} from '@stellar/freighter-api';
import { StellarWalletsKit, WalletNetwork, allowAllModules } from '@creit.tech/stellar-wallets-kit';
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { xBullModule } from '@creit.tech/stellar-wallets-kit/modules/xbull';
import { LobstrModule } from '@creit.tech/stellar-wallets-kit/modules/lobstr';
import { getNetworkConfig } from '../config/stellar';
import { withRetry, DEFAULT_RETRY_CONFIG } from '../utils/retry';

// ---------------------------------------------------------------------------
// Browser compatibility assumptions (explicit)
// ---------------------------------------------------------------------------
// Freighter is a browser extension and relies on the following browser APIs:
//   - window.freighter (injected by the extension into the page context)
//   - navigator.clipboard (used by WalletInfo for address copy)
//   - window.addEventListener / CustomEvent (used by WatchWalletChanges)
//
// Supported environments:
//   - Chrome / Chromium 90+  (Freighter extension available)
//   - Firefox 90+            (Freighter extension available)
//   - Brave (Chromium-based) (Freighter extension available)
//   - Edge (Chromium-based)  (Freighter extension available)
//
// Unsupported / degraded environments:
//   - Safari: Freighter extension not available in the Safari Web Store.
//             WalletService.isInstalled() returns false; UI shows install prompt.
//   - Mobile browsers: Extension APIs unavailable; same degraded path as Safari.
//   - SSR / Node.js: window is undefined; all methods return safe defaults.
//
// The helpers below make these assumptions testable and explicit.
// ---------------------------------------------------------------------------

/** Returns true when running in a browser context (not SSR/Node). */
export function isBrowserEnvironment(): boolean {
    return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

/**
 * Returns true when the Freighter extension has injected its API into the page.
 * This is a synchronous pre-check; use WalletService.isInstalled() for the
 * authoritative async check that also verifies the extension is responsive.
 */
export function isFreighterInjected(): boolean {
    return isBrowserEnvironment() && typeof (window as any).freighter !== 'undefined';
}

/**
 * Returns true when the Clipboard API is available.
 * Older browsers and non-secure contexts (HTTP) may not support it.
 */
export function isClipboardApiAvailable(): boolean {
    return isBrowserEnvironment() && typeof navigator.clipboard !== 'undefined';
}

// ---------------------------------------------------------------------------
// Wallet adapter interface
// ---------------------------------------------------------------------------
// A WalletAdapter abstracts a single Stellar wallet implementation so that
// additional wallets (Albedo, xBull, Lobstr, ...) can be plugged in without
// changing the rest of the application. The Freighter adapter wraps the
// existing @stellar/freighter-api logic; the others are backed by the
// Stellar Wallets Kit.
// ---------------------------------------------------------------------------

export type WalletId = 'freighter' | 'albedo' | 'xbull' | 'lobstr';

export interface WalletAdapter {
    /** Stable identifier used for persistence and lookups. */
    id: WalletId;
    /** Human readable name shown in the UI. */
    name: string;
    /** Icon URL or data URI shown in the UI. */
    icon: string;
    /** Returns true when the wallet is available in the current environment. */
    isAvailable(): Promise<boolean>;
    /** Requests access and returns the connected public key. */
    connect(): Promise<string>;
    /** Returns the currently connected public key, or null. */
    getPublicKey(): Promise<string | null>;
    /** Signs a transaction XDR and returns the signed XDR, or null on failure. */
    signTransaction(xdr: string, networkPassphrase?: string): Promise<string | null>;
    /** Watches for wallet address/network changes; returns an unsubscribe fn. */
    watchChanges(callback: (params: { address: string; network: string }) => void): () => void;
}

/** Maps an app network ('testnet' | 'mainnet') to a Stellar Wallets Kit network. */
function toKitNetwork(network: 'testnet' | 'mainnet'): WalletNetwork {
    return network === 'mainnet' ? WalletNetwork.PUBLIC : WalletNetwork.TESTNET;
}

/**
 * Creates a Stellar Wallets Kit backed adapter for the given module.
 * The kit is instantiated lazily so that importing this module never touches
 * browser-only globals (important for SSR and tests).
 */
function createKitAdapter(
    id: WalletId,
    name: string,
    icon: string,
    module: any,
): WalletAdapter {
    let kit: StellarWalletsKit | null = null;

    const getKit = (): StellarWalletsKit => {
        if (!kit) {
            kit = new StellarWalletsKit({
                network: WalletNetwork.TESTNET,
                selectedWalletId: id,
                modules: [module],
            });
        }
        return kit;
    };

    return {
        id,
        name,
        icon,
        async isAvailable(): Promise<boolean> {
            if (!isBrowserEnvironment()) {
                return false;
            }
            try {
                // The kit module exposes isAvailable when the wallet supports it.
                if (typeof module?.isAvailable === 'function') {
                    return !!(await module.isAvailable());
                }
                // Fall back to assuming availability for web-based wallets.
                return true;
            } catch {
                return false;
            }
        },
        async connect(): Promise<string> {
            const address = await getKit().getAddress();
            if (!address) {
                throw new Error(`Failed to retrieve ${name} wallet address`);
            }
            return address;
        },
        async getPublicKey(): Promise<string | null> {
            try {
                const address = await getKit().getAddress();
                return address || null;
            } catch {
                return null;
            }
        },
        async signTransaction(xdr: string, networkPassphrase?: string): Promise<string | null> {
            try {
                const result = await getKit().signTransaction({
                    transaction: xdr,
                    network: networkPassphrase
                        ? (networkPassphrase.toLowerCase().includes('public')
                            ? WalletNetwork.PUBLIC
                            : WalletNetwork.TESTNET)
                        : WalletNetwork.TESTNET,
                });
                return result?.signedTxXdr || null;
            } catch (error) {
                console.error(`Error signing transaction with ${name}:`, error);
                return null;
            }
        },
        watchChanges(callback: (params: { address: string; network: string }) => void): () => void {
            // The Stellar Wallets Kit does not expose a cross-wallet watcher;
            // return a no-op unsubscribe so callers can use a uniform API.
            void callback;
            return () => {};
        },
    };
}

/** Freighter adapter wrapping the existing @stellar/freighter-api logic. */
export const freighterAdapter: WalletAdapter = {
    id: 'freighter',
    name: 'Freighter',
    icon: 'https://www.freighter.app/favicon.ico',
    async isAvailable(): Promise<boolean> {
        try {
            const result = await withRetry(() => isConnected(), DEFAULT_RETRY_CONFIG);
            return !!result.isConnected;
        } catch {
            return false;
        }
    },
    async connect(): Promise<string> {
        const available = await this.isAvailable();
        if (!available) {
            throw new Error('Freighter wallet is not installed. Please install it from https://www.freighter.app/');
        }

        try {
            await requestAccess();
            const result = await getAddress();
            if (!result.address) {
                throw new Error('Failed to retrieve wallet address');
            }
            return result.address;
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('User declined')) {
                    throw new Error('Connection request rejected by user');
                }
                throw error;
            }
            throw new Error('Failed to connect to Freighter wallet');
        }
    },
    async getPublicKey(): Promise<string | null> {
        try {
            const result = await withRetry(() => getAddress(), DEFAULT_RETRY_CONFIG);
            return result.address || null;
        } catch {
            return null;
        }
    },
    async signTransaction(xdr: string, networkPassphrase?: string): Promise<string | null> {
        try {
            const result = await signTransaction(xdr, { networkPassphrase });
            return result.signedTxXdr || null;
        } catch (error) {
            console.error('Error signing transaction:', error);
            return null;
        }
    },
    watchChanges(callback: (params: { address: string; network: string }) => void): () => void {
        const watcher = new WatchWalletChanges();
        watcher.watch((params) => {
            callback({
                address: params.address,
                network: params.network,
            });
        });
        return () => watcher.stop();
    },
};

/** Albedo adapter backed by the Stellar Wallets Kit. */
export const albedoAdapter: WalletAdapter = createKitAdapter(
    'albedo',
    'Albedo',
    'https://albedo.link/img/albedo.svg',
    AlbedoModule,
);

/** xBull adapter backed by the Stellar Wallets Kit. */
export const xbullAdapter: WalletAdapter = createKitAdapter(
    'xbull',
    'xBull',
    'https://xbull.app/favicon.ico',
    xBullModule,
);

/** Lobstr adapter backed by the Stellar Wallets Kit. */
export const lobstrAdapter: WalletAdapter = createKitAdapter(
    'lobstr',
    'Lobstr',
    'https://lobstr.co/favicon.ico',
    LobstrModule,
);

/** Registry of all supported wallet adapters, in UI display order. */
export const walletRegistry: WalletAdapter[] = [
    freighterAdapter,
    albedoAdapter,
    xbullAdapter,
    lobstrAdapter,
];

/** Looks up an adapter by id, returning undefined when unknown. */
export function getWalletAdapter(id: WalletId): WalletAdapter | undefined {
    return walletRegistry.find((adapter) => adapter.id === id);
}

/** Returns the adapters that are currently available in this environment. */
export async function getAvailableWallets(): Promise<WalletAdapter[]> {
    const results = await Promise.all(
        walletRegistry.map(async (adapter) => ({
            adapter,
            available: await adapter.isAvailable(),
        })),
    );
    return results.filter((r) => r.available).map((r) => r.adapter);
}

export class WalletService {
    private static selectedAdapter: WalletAdapter = freighterAdapter;

    /** Selects the adapter used by the static WalletService API. */
    static selectWallet(id: WalletId): void {
        const adapter = getWalletAdapter(id);
        if (!adapter) {
            throw new Error(`Unsupported wallet: ${id}`);
        }
        WalletService.selectedAdapter = adapter;
    }

    /** Returns the currently selected adapter. */
    static getSelectedWallet(): WalletAdapter {
        return WalletService.selectedAdapter;
    }

    static async isInstalled(): Promise<boolean> {
        return WalletService.selectedAdapter.isAvailable();
    }

    static async connect(): Promise<string> {
        return WalletService.selectedAdapter.connect();
    }

    static disconnect(): void {
        // Wallets don't expose a disconnect method
        // Disconnection is handled by the app clearing its state
    }

    static async getPublicKey(): Promise<string | null> {
        return WalletService.selectedAdapter.getPublicKey();
    }

    static async getNetwork(): Promise<'testnet' | 'mainnet'> {
        try {
            const result = await withRetry(() => getNetwork(), DEFAULT_RETRY_CONFIG);
            const network = result.network || 'testnet';
            return network.toLowerCase().includes('public') ? 'mainnet' : 'testnet';
        } catch {
            return 'testnet';
        }
    }

    static async getBalance(address: string): Promise<string> {
        if (!address || address.length !== 56 || !address.startsWith('G')) {
            throw new Error('Invalid Stellar address');
        }

        try {
            const network = await this.getNetwork();
            const config = getNetworkConfig(network);
            
            const response = await fetch(`${config.horizonUrl}/accounts/${address}`);
            
            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error('Account not found. Please fund your account first.');
                }
                throw new Error(`Failed to fetch balance: ${response.statusText}`);
            }

            const account = await response.json();
            const nativeBalance = account.balances?.find(
                (b: any) => b.asset_type === 'native'
            );

            return nativeBalance?.balance || '0';
        } catch (error) {
            if (error instanceof Error) {
                throw error;
            }
            throw new Error('Failed to retrieve account balance');
        }
    }

    static async signTransaction(xdr: string, networkPassphrase?: string): Promise<string | null> {
        return WalletService.selectedAdapter.signTransaction(xdr, networkPassphrase);
    }

    static watchChanges(callback: (params: { address: string; network: string }) => void): () => void {
        return WalletService.selectedAdapter.watchChanges(callback);
    }
}
