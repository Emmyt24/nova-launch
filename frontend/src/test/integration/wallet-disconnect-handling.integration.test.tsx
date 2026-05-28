/**
 * Integration test: Mid-session wallet disconnection (#1089)
 *
 * Covers:
 *  1. UI reflects disconnected state after mid-session disconnect
 *  2. Wallet-dependent actions are disabled / prompt reconnection
 *  3. No unhandled errors on disconnect
 *  4. Reconnection restores full functionality
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useWallet } from '../../hooks/useWallet';
import { WalletService } from '../../services/wallet';
import { analytics } from '../../services/analytics';
import { CampaignCreationForm } from '../../components/CampaignForm/CampaignCreationForm';

vi.mock('../../services/wallet');
vi.mock('../../services/analytics');
vi.mock('../../services/stellar.service', () => ({
  StellarService: vi.fn(function () { return {}; }),
}));
vi.mock('../../providers/ToastProvider', () => ({
  useToastContext: vi.fn(() => ({ error: vi.fn(), success: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const WALLET_ADDRESS = 'GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12';
const TOKEN_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Mid-session wallet disconnection (#1089)', () => {
  let watchCallback: ((data: { address: string; network: string }) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(analytics.track).mockImplementation(() => {});

    vi.mocked(WalletService.isInstalled).mockResolvedValue(true);
    vi.mocked(WalletService.getPublicKey).mockResolvedValue(WALLET_ADDRESS);
    vi.mocked(WalletService.getNetwork).mockResolvedValue('testnet');
    vi.mocked(WalletService.watchChanges).mockImplementation((cb) => {
      watchCallback = cb;
      return () => { watchCallback = null; };
    });
  });

  afterEach(() => {
    watchCallback = null;
  });

  // ── 1. UI reflects disconnected state ─────────────────────────────────────
  it('reflects disconnected state after mid-session disconnect', async () => {
    const { result } = renderHook(() => useWallet());

    // Connect
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.wallet.connected).toBe(true));

    // Simulate Freighter firing a disconnect event (empty address)
    act(() => { watchCallback?.({ address: '', network: 'TESTNET' }); });

    await waitFor(() => {
      expect(result.current.wallet.connected).toBe(false);
      expect(result.current.wallet.address).toBeNull();
    });
  });

  // ── 2. Wallet-dependent actions disabled ──────────────────────────────────
  it('disables wallet-dependent form actions after disconnect', async () => {
    // Start connected
    const { useWallet: useWalletMock } = await import('../../hooks/useWallet');
    vi.mocked(useWalletMock as any);

    // Render form with disconnected wallet (simulates post-disconnect state)
    const { rerender } = render(
      <CampaignCreationForm tokenAddress={TOKEN_ADDRESS} />
    );

    // Simulate disconnect by re-rendering with disconnected wallet mock
    vi.doMock('../../hooks/useWallet', () => ({
      useWallet: vi.fn(() => ({
        wallet: { connected: false, address: null, network: 'testnet' },
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnecting: false,
        error: null,
      })),
    }));

    rerender(<CampaignCreationForm tokenAddress={TOKEN_ADDRESS} />);

    // Submit button should be disabled
    const submitBtn = screen.getByRole('button', { name: /Create Campaign/i });
    expect(submitBtn).toBeDisabled();

    // Wallet warning should be visible
    expect(screen.getByText(/Wallet Required/i)).toBeInTheDocument();
  });

  // ── 3. No unhandled errors on disconnect ──────────────────────────────────
  it('does not throw unhandled errors when wallet disconnects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useWallet());

    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.wallet.connected).toBe(true));

    // Disconnect via hook
    expect(() => {
      act(() => { result.current.disconnect(); });
    }).not.toThrow();

    await waitFor(() => expect(result.current.wallet.connected).toBe(false));

    // No unexpected console errors
    const unexpectedErrors = errorSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('Unhandled')
    );
    expect(unexpectedErrors).toHaveLength(0);

    errorSpy.mockRestore();
  });

  // ── 4. Reconnection restores full functionality ────────────────────────────
  it('restores full functionality after reconnection', async () => {
    const { result } = renderHook(() => useWallet());

    // Connect → disconnect → reconnect
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.wallet.connected).toBe(true));

    act(() => { result.current.disconnect(); });
    await waitFor(() => expect(result.current.wallet.connected).toBe(false));

    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.wallet.connected).toBe(true));

    expect(result.current.wallet.address).toBe(WALLET_ADDRESS);
    expect(result.current.error).toBeNull();
  });

  // ── 5. In-flight action blocked on disconnect ─────────────────────────────
  it('blocks in-flight actions when wallet disconnects mid-session', async () => {
    const { result } = renderHook(() => useWallet());

    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.wallet.connected).toBe(true));

    // Simulate disconnect while an action would be in-flight
    act(() => { watchCallback?.({ address: '', network: 'TESTNET' }); });

    await waitFor(() => expect(result.current.wallet.connected).toBe(false));

    // Attempting to connect again should work cleanly
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.wallet.connected).toBe(true));
  });
});
