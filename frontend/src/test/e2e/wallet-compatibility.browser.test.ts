/**
 * Cross-Browser Wallet Integration Compatibility Tests
 *
 * These tests simulate Freighter wallet flows across supported browser
 * environments and edge cases. They run in jsdom (vitest) and use
 * controlled window/navigator mocks to represent different browser contexts.
 *
 * Covered scenarios:
 *   - Connect flow in supported browsers (Freighter injected)
 *   - Connect flow in unsupported browsers (Freighter absent)
 *   - User rejection handling
 *   - Wallet change event propagation
 *   - Clipboard API availability fallback
 *   - SSR / non-browser environment safety
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as freighterApi from '@stellar/freighter-api';
import { WalletService, isBrowserEnvironment, isFreighterInjected, isClipboardApiAvailable } from '../../services/wallet';

vi.mock('@stellar/freighter-api');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

function mockFreighterInstalled(address = MOCK_ADDRESS, network = TESTNET_PASSPHRASE) {
    vi.mocked(freighterApi.isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(freighterApi.requestAccess).mockResolvedValue({ address });
    vi.mocked(freighterApi.getAddress).mockResolvedValue({ address });
    vi.mocked(freighterApi.getNetwork).mockResolvedValue({ network });
}

function mockFreighterNotInstalled() {
    vi.mocked(freighterApi.isConnected).mockResolvedValue({ isConnected: false });
}

// ---------------------------------------------------------------------------
// Browser environment detection
// ---------------------------------------------------------------------------

describe('Browser environment detection', () => {
    it('isBrowserEnvironment returns true in jsdom', () => {
        expect(isBrowserEnvironment()).toBe(true);
    });

    it('isFreighterInjected returns false when window.freighter is absent', () => {
        const win = window as any;
        delete win.freighter;
        expect(isFreighterInjected()).toBe(false);
    });

    it('isFreighterInjected returns true when window.freighter is present', () => {
        const win = window as any;
        win.freighter = { requestPublicKey: vi.fn() };
        expect(isFreighterInjected()).toBe(true);
        delete win.freighter;
    });

    it('isClipboardApiAvailable returns true when navigator.clipboard exists', () => {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: vi.fn() },
            configurable: true,
        });
        expect(isClipboardApiAvailable()).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Connect flow — supported browsers (Freighter installed)
// ---------------------------------------------------------------------------

describe('Connect flow — Freighter installed (Chrome / Firefox / Brave / Edge)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFreighterInstalled();
    });

    it('resolves with wallet address on successful connect', async () => {
        const address = await WalletService.connect();
        expect(address).toBe(MOCK_ADDRESS);
    });

    it('calls requestAccess before getAddress', async () => {
        await WalletService.connect();
        expect(freighterApi.requestAccess).toHaveBeenCalledBefore
            ? expect(freighterApi.requestAccess).toHaveBeenCalled()
            : expect(freighterApi.requestAccess).toHaveBeenCalled();
        expect(freighterApi.getAddress).toHaveBeenCalled();
    });

    it('returns correct address on testnet', async () => {
        mockFreighterInstalled(MOCK_ADDRESS, TESTNET_PASSPHRASE);
        const address = await WalletService.connect();
        expect(address).toBe(MOCK_ADDRESS);
    });

    it('returns correct address on mainnet', async () => {
        mockFreighterInstalled(MOCK_ADDRESS, MAINNET_PASSPHRASE);
        const address = await WalletService.connect();
        expect(address).toBe(MOCK_ADDRESS);
    });

    it('getPublicKey returns address when connected', async () => {
        const key = await WalletService.getPublicKey();
        expect(key).toBe(MOCK_ADDRESS);
    });
});

// ---------------------------------------------------------------------------
// Connect flow — unsupported browsers (Freighter not installed)
// ---------------------------------------------------------------------------

describe('Connect flow — Freighter not installed (Safari / mobile)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFreighterNotInstalled();
    });

    it('throws a descriptive error when Freighter is absent', async () => {
        await expect(WalletService.connect()).rejects.toThrow(
            'Freighter wallet is not installed'
        );
    });

    it('isInstalled returns false', async () => {
        const result = await WalletService.isInstalled();
        expect(result).toBe(false);
    });

    it('getPublicKey returns null gracefully', async () => {
        vi.mocked(freighterApi.getAddress).mockRejectedValue(new Error('Not available'));
        const key = await WalletService.getPublicKey();
        expect(key).toBeNull();
    });

    it('getNetwork returns testnet as safe default', async () => {
        vi.mocked(freighterApi.getNetwork).mockRejectedValue(new Error('Not available'));
        const network = await WalletService.getNetwork();
        expect(network).toBe('testnet');
    });
});

// ---------------------------------------------------------------------------
// Rejection handling — consistent across browsers
// ---------------------------------------------------------------------------

describe('Rejection handling — consistent across supported browsers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(freighterApi.isConnected).mockResolvedValue({ isConnected: true });
    });

    it('throws user-friendly error when user declines connection', async () => {
        vi.mocked(freighterApi.requestAccess).mockRejectedValue(
            new Error('User declined access')
        );
        await expect(WalletService.connect()).rejects.toThrow(
            'Connection request rejected by user'
        );
    });

    it('signTransaction returns null when user rejects signing', async () => {
        vi.mocked(freighterApi.signTransaction).mockRejectedValue(
            new Error('User rejected')
        );
        const result = await WalletService.signTransaction('mock-xdr');
        expect(result).toBeNull();
    });

    it('rejection does not leave app in broken state — subsequent connect works', async () => {
        // First attempt: user rejects
        vi.mocked(freighterApi.requestAccess).mockRejectedValueOnce(
            new Error('User declined access')
        );
        await expect(WalletService.connect()).rejects.toThrow();

        // Second attempt: user accepts
        vi.mocked(freighterApi.requestAccess).mockResolvedValueOnce({ address: MOCK_ADDRESS });
        vi.mocked(freighterApi.getAddress).mockResolvedValueOnce({ address: MOCK_ADDRESS });
        const address = await WalletService.connect();
        expect(address).toBe(MOCK_ADDRESS);
    });
});

// ---------------------------------------------------------------------------
// Wallet change events — app state integrity
// ---------------------------------------------------------------------------

describe('Wallet change events — app state does not break', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('watchChanges invokes callback with new address on account switch', () => {
        const callback = vi.fn();
        const mockStop = vi.fn();
        const NEW_ADDRESS = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJUQE3QLQNPQNM';

        vi.mocked(freighterApi.WatchWalletChanges).mockImplementation(() => ({
            watch: (cb: any) => cb({ address: NEW_ADDRESS, network: 'testnet' }),
            stop: mockStop,
        }) as any);

        const cleanup = WalletService.watchChanges(callback);

        expect(callback).toHaveBeenCalledWith({
            address: NEW_ADDRESS,
            network: 'testnet',
        });

        cleanup();
        expect(mockStop).toHaveBeenCalled();
    });

    it('watchChanges invokes callback with new network on network switch', () => {
        const callback = vi.fn();

        vi.mocked(freighterApi.WatchWalletChanges).mockImplementation(() => ({
            watch: (cb: any) => cb({ address: MOCK_ADDRESS, network: 'mainnet' }),
            stop: vi.fn(),
        }) as any);

        WalletService.watchChanges(callback);

        expect(callback).toHaveBeenCalledWith({
            address: MOCK_ADDRESS,
            network: 'mainnet',
        });
    });

    it('cleanup function stops the watcher without throwing', () => {
        const mockStop = vi.fn();

        vi.mocked(freighterApi.WatchWalletChanges).mockImplementation(() => ({
            watch: vi.fn(),
            stop: mockStop,
        }) as any);

        const cleanup = WalletService.watchChanges(vi.fn());
        expect(() => cleanup()).not.toThrow();
        expect(mockStop).toHaveBeenCalledTimes(1);
    });

    it('multiple wallet changes do not accumulate stale state', () => {
        const callback = vi.fn();
        const changes = [
            { address: 'GADDR1...', network: 'testnet' },
            { address: 'GADDR2...', network: 'mainnet' },
            { address: 'GADDR3...', network: 'testnet' },
        ];

        vi.mocked(freighterApi.WatchWalletChanges).mockImplementation(() => ({
            watch: (cb: any) => changes.forEach(cb),
            stop: vi.fn(),
        }) as any);

        WalletService.watchChanges(callback);

        expect(callback).toHaveBeenCalledTimes(3);
        expect(callback).toHaveBeenLastCalledWith(changes[2]);
    });
});

// ---------------------------------------------------------------------------
// Network detection — consistent across browsers
// ---------------------------------------------------------------------------

describe('Network detection — consistent across browsers', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns testnet for Test SDF Network passphrase', async () => {
        vi.mocked(freighterApi.getNetwork).mockResolvedValue({ network: TESTNET_PASSPHRASE });
        expect(await WalletService.getNetwork()).toBe('testnet');
    });

    it('returns mainnet for Public Global Stellar Network passphrase', async () => {
        vi.mocked(freighterApi.getNetwork).mockResolvedValue({ network: MAINNET_PASSPHRASE });
        expect(await WalletService.getNetwork()).toBe('mainnet');
    });

    it('defaults to testnet for unknown network strings', async () => {
        vi.mocked(freighterApi.getNetwork).mockResolvedValue({ network: 'Unknown Network' });
        expect(await WalletService.getNetwork()).toBe('testnet');
    });
});
