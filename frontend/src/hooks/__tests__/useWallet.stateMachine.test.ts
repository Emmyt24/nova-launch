/**
 * Issue #1082 — Validate wallet connection state handling across connect,
 * disconnect, and account-switch events.
 *
 * Covers:
 *   1. Initial disconnected state and a successful connect transition.
 *   2. Disconnect clears the stored account.
 *   3. Account switch updates the active address.
 *   4. Connect failure (wallet not installed / user declined).
 *
 * Freighter API is fully mocked via vi.mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useWallet, WALLET_CONNECTED_KEY } from '../useWallet';
import { WalletService } from '../../services/wallet';
import { analytics } from '../../services/analytics';

vi.mock('../../services/wallet');
vi.mock('../../services/analytics');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Valid Stellar addresses: G + 55 chars from [A-Z2-7] */
const ADDR_1 = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
const ADDR_2 = 'GHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ2345';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(analytics.track).mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useWallet state transitions (#1082)', () => {
  describe('1. Initial disconnected state', () => {
    it('starts disconnected with null address and testnet as default', () => {
      const { result } = renderHook(() => useWallet());

      expect(result.current.wallet).toEqual({
        connected: false,
        address: null,
        network: 'testnet',
      });
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('does not attempt auto-reconnect when localStorage has no flag', async () => {
      renderHook(() => useWallet());

      // Give the effect a tick to run
      await new Promise((r) => setTimeout(r, 10));

      expect(WalletService.isInstalled).not.toHaveBeenCalled();
    });
  });

  describe('2. Successful connect transition', () => {
    it('transitions from disconnected to connected with correct address and network', async () => {
      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockReturnValue(() => {});

      const { result } = renderHook(() => useWallet());

      await act(async () => { await result.current.connect(); });

      expect(result.current.wallet.connected).toBe(true);
      expect(result.current.wallet.address).toBe(ADDR_1);
      expect(result.current.wallet.network).toBe('testnet');
      expect(result.current.error).toBeNull();
      expect(result.current.isConnecting).toBe(false);
    });

    it('persists connection flag to localStorage on successful connect', async () => {
      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockReturnValue(() => {});

      const { result } = renderHook(() => useWallet());

      await act(async () => { await result.current.connect(); });

      expect(localStorage.getItem(WALLET_CONNECTED_KEY)).toBe('true');
    });

    it('sets isConnecting=true during the async connect and false after', async () => {
      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(ADDR_1), 50))
      );
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockReturnValue(() => {});

      const { result } = renderHook(() => useWallet());

      act(() => { result.current.connect(); });

      expect(result.current.isConnecting).toBe(true);

      await waitFor(() => expect(result.current.isConnecting).toBe(false));
      expect(result.current.wallet.connected).toBe(true);
    });
  });

  describe('3. Disconnect clears stored account', () => {
    async function connectWallet(result: any) {
      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockReturnValue(() => {});
      await act(async () => { await result.connect(); });
    }

    it('disconnect sets connected=false and address=null', async () => {
      const { result } = renderHook(() => useWallet());
      await connectWallet(result.current);

      await waitFor(() => expect(result.current.wallet.connected).toBe(true));

      act(() => { result.current.disconnect(); });

      expect(result.current.wallet.connected).toBe(false);
      expect(result.current.wallet.address).toBeNull();
    });

    it('disconnect removes the localStorage flag', async () => {
      const { result } = renderHook(() => useWallet());
      await connectWallet(result.current);

      await waitFor(() => expect(result.current.wallet.connected).toBe(true));
      expect(localStorage.getItem(WALLET_CONNECTED_KEY)).toBe('true');

      act(() => { result.current.disconnect(); });

      expect(localStorage.getItem(WALLET_CONNECTED_KEY)).toBeNull();
    });

    it('disconnect clears any existing error', async () => {
      // Simulate a failed connect that sets an error, then disconnect
      vi.mocked(WalletService.isInstalled).mockResolvedValue(false);
      const { result } = renderHook(() => useWallet());

      await act(async () => { await result.current.connect(); });
      expect(result.current.error).toBeTruthy();

      // Now simulate a successful connect to get connected state
      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockReturnValue(() => {});
      await act(async () => { await result.current.connect(); });

      act(() => { result.current.disconnect(); });

      expect(result.current.error).toBeNull();
    });

    it('calls the cleanup function returned by watchChanges on disconnect', async () => {
      const mockCleanup = vi.fn();
      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockReturnValue(mockCleanup);

      const { result } = renderHook(() => useWallet());
      await act(async () => { await result.current.connect(); });

      act(() => { result.current.disconnect(); });

      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. Account switch updates the active address', () => {
    it('watchChanges callback with a new address updates wallet.address', async () => {
      let changeCallback: ((data: { address: string; network: string }) => void) | null = null;

      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockImplementation((cb) => {
        changeCallback = cb;
        return () => {};
      });

      const { result } = renderHook(() => useWallet());
      await act(async () => { await result.current.connect(); });

      await waitFor(() => expect(result.current.wallet.address).toBe(ADDR_1));

      // Simulate Freighter account switch
      act(() => {
        changeCallback!({ address: ADDR_2, network: 'TESTNET' });
      });

      await waitFor(() => expect(result.current.wallet.address).toBe(ADDR_2));
      expect(result.current.wallet.connected).toBe(true);
    });

    it('watchChanges callback with empty address triggers disconnect', async () => {
      let changeCallback: ((data: { address: string; network: string }) => void) | null = null;

      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockImplementation((cb) => {
        changeCallback = cb;
        return () => {};
      });

      const { result } = renderHook(() => useWallet());
      await act(async () => { await result.current.connect(); });

      await waitFor(() => expect(result.current.wallet.connected).toBe(true));

      act(() => {
        changeCallback!({ address: '', network: 'TESTNET' });
      });

      await waitFor(() => expect(result.current.wallet.connected).toBe(false));
      expect(result.current.wallet.address).toBeNull();
    });

    it('network switch via watchChanges updates wallet.network', async () => {
      let changeCallback: ((data: { address: string; network: string }) => void) | null = null;

      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockImplementation((cb) => {
        changeCallback = cb;
        return () => {};
      });

      const { result } = renderHook(() => useWallet());
      await act(async () => { await result.current.connect(); });

      await waitFor(() => expect(result.current.wallet.network).toBe('testnet'));

      act(() => {
        changeCallback!({ address: ADDR_1, network: 'Public Global Stellar Network ; September 2015' });
      });

      await waitFor(() => expect(result.current.wallet.network).toBe('mainnet'));
    });
  });

  describe('5. Connect failure scenarios', () => {
    it('sets error when Freighter is not installed', async () => {
      vi.mocked(WalletService.isInstalled).mockResolvedValue(false);

      const { result } = renderHook(() => useWallet());

      await act(async () => { await result.current.connect(); });

      expect(result.current.error).toBe('Freighter wallet is not installed');
      expect(result.current.wallet.connected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
    });

    it('sets error when user declines (getPublicKey returns null)', async () => {
      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(null);

      const { result } = renderHook(() => useWallet());

      await act(async () => { await result.current.connect(); });

      expect(result.current.error).toBeTruthy();
      expect(result.current.wallet.connected).toBe(false);
    });

    it('sets error when WalletService.isInstalled throws', async () => {
      vi.mocked(WalletService.isInstalled).mockRejectedValue(new Error('extension crashed'));

      const { result } = renderHook(() => useWallet());

      await act(async () => { await result.current.connect(); });

      expect(result.current.error).toBeTruthy();
      expect(result.current.wallet.connected).toBe(false);
    });

    it('does not persist localStorage flag on failed connect', async () => {
      vi.mocked(WalletService.isInstalled).mockResolvedValue(false);

      const { result } = renderHook(() => useWallet());

      await act(async () => { await result.current.connect(); });

      expect(localStorage.getItem(WALLET_CONNECTED_KEY)).toBeNull();
    });
  });

  describe('6. Auto-reconnect on mount', () => {
    it('auto-reconnects when localStorage flag is set and wallet is available', async () => {
      localStorage.setItem(WALLET_CONNECTED_KEY, 'true');

      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockReturnValue(() => {});

      const { result } = renderHook(() => useWallet());

      await waitFor(() => expect(result.current.wallet.connected).toBe(true), { timeout: 3_000 });
      expect(result.current.wallet.address).toBe(ADDR_1);
    });

    it('clears localStorage flag when wallet is not installed on auto-reconnect', async () => {
      localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
      vi.mocked(WalletService.isInstalled).mockResolvedValue(false);

      renderHook(() => useWallet());

      await waitFor(() => expect(localStorage.getItem(WALLET_CONNECTED_KEY)).toBeNull());
    });
  });

  describe('7. Cleanup on unmount', () => {
    it('calls the watchChanges cleanup function on unmount', async () => {
      const mockCleanup = vi.fn();
      vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
      vi.mocked(WalletService.getPublicKey).mockResolvedValue(ADDR_1);
      vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
      vi.mocked(WalletService.watchChanges).mockReturnValue(mockCleanup);

      const { result, unmount } = renderHook(() => useWallet());
      await act(async () => { await result.current.connect(); });

      unmount();

      expect(mockCleanup).toHaveBeenCalled();
    });
  });
});
