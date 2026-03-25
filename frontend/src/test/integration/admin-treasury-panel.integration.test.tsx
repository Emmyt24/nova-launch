/**
 * Admin Treasury Panel — Integration Tests
 *
 * Verifies:
 *   1. Admin, proposed admin, treasury, fees, and pause state render correctly
 *   2. Treasury policy (daily cap, usage, allowlist) renders correctly
 *   3. Timelock config and pending change render correctly
 *   4. Network change triggers a reload
 *   5. Privileged action buttons are present, clearly labelled, and gated
 *   6. Error state renders when contract reads fail
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FactoryAdminPanel } from '../../components/Admin/FactoryAdminPanel';
import type { FactoryAdminState, TreasuryPolicy, TimelockConfig, PendingChange } from '../../types/admin';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIN_ADDRESS = 'GADMINADDRESSVALIDSTELLAR0000000000000000000000000000001';
const PROPOSED_ADMIN = 'GPROPOSEDADDRVALIDSTELLAR000000000000000000000000000001';
const TREASURY_ADDRESS = 'GTREASURYADDRESSVALIDSTELLAR00000000000000000000000001';

const mockAdminState: FactoryAdminState = {
  admin: ADMIN_ADDRESS,
  proposedAdmin: PROPOSED_ADMIN,
  treasury: TREASURY_ADDRESS,
  baseFee: 70_000_000n,
  metadataFee: 30_000_000n,
  paused: false,
};

const mockAdminStatePaused: FactoryAdminState = {
  ...mockAdminState,
  paused: true,
  proposedAdmin: null,
};

const mockTreasuryPolicy: TreasuryPolicy = {
  dailyCap: 1_000_000_000n,
  withdrawnToday: 350_000_000n,
  remainingCapacity: 650_000_000n,
  allowedRecipients: [TREASURY_ADDRESS, ADMIN_ADDRESS],
};

const mockTimelockConfig: TimelockConfig = {
  minDelay: 3600,
  maxDelay: 86400,
};

const mockPendingChange: PendingChange = {
  changeType: 'FEE_UPDATE',
  executeAfter: Math.floor(Date.now() / 1000) + 7200,
  description: 'Update base fee to 80000000 stroops',
};

// ── StellarService mock ───────────────────────────────────────────────────────

vi.mock('../../services/stellar.service', () => ({
  StellarService: vi.fn().mockImplementation(() => ({
    getAdminState: vi.fn().mockResolvedValue(mockAdminState),
    getTreasuryPolicy: vi.fn().mockResolvedValue(mockTreasuryPolicy),
    getTimelockConfig: vi.fn().mockResolvedValue(mockTimelockConfig),
    getPendingChange: vi.fn().mockResolvedValue(mockPendingChange),
  })),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FactoryAdminPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Admin state ──────────────────────────────────────────────────────────

  describe('Admin state', () => {
    it('renders current admin address', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      expect(await screen.findByText(ADMIN_ADDRESS)).toBeInTheDocument();
    });

    it('renders proposed admin with pending transfer warning', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      expect(await screen.findByText(PROPOSED_ADMIN)).toBeInTheDocument();
      expect(screen.getByText(/admin transfer is pending/i)).toBeInTheDocument();
    });

    it('renders treasury address', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      expect(await screen.findByText(TREASURY_ADDRESS)).toBeInTheDocument();
    });

    it('renders base fee and metadata fee in XLM', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      // 70_000_000 stroops = 7 XLM
      expect(await screen.findByText(/7\.00/)).toBeInTheDocument();
      // 30_000_000 stroops = 3 XLM
      expect(screen.getByText(/3\.00/)).toBeInTheDocument();
    });

    it('shows active status when not paused', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      expect(await screen.findByText(/active/i)).toBeInTheDocument();
    });

    it('shows PAUSED badge and warning when contract is paused', async () => {
      const { StellarService } = await import('../../services/stellar.service');
      vi.mocked(StellarService).mockImplementationOnce(() => ({
        getAdminState: vi.fn().mockResolvedValue(mockAdminStatePaused),
        getTreasuryPolicy: vi.fn().mockResolvedValue(mockTreasuryPolicy),
        getTimelockConfig: vi.fn().mockResolvedValue(mockTimelockConfig),
        getPendingChange: vi.fn().mockResolvedValue(null),
      }) as any);

      render(<FactoryAdminPanel network="testnet" />);
      expect(await screen.findByText(/paused/i)).toBeInTheDocument();
      expect(screen.getByText(/token creation is disabled/i)).toBeInTheDocument();
    });
  });

  // ── 2. Treasury policy ──────────────────────────────────────────────────────

  describe('Treasury policy', () => {
    it('renders daily cap in XLM', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      // 1_000_000_000 stroops = 100 XLM
      expect(await screen.findByText(/100\.00/)).toBeInTheDocument();
    });

    it('renders remaining capacity', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      // 650_000_000 stroops = 65 XLM
      expect(await screen.findByText(/65\.00/)).toBeInTheDocument();
    });

    it('renders allowlisted recipients', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      await screen.findByText(TREASURY_ADDRESS);
      expect(screen.getAllByText(ADMIN_ADDRESS).length).toBeGreaterThanOrEqual(1);
    });

    it('shows privileged action warning for treasury operations', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      await screen.findByText(TREASURY_ADDRESS);
      expect(screen.getByText(/withdrawals and allowlist changes are privileged/i)).toBeInTheDocument();
    });
  });

  // ── 3. Timelock ─────────────────────────────────────────────────────────────

  describe('Timelock config', () => {
    it('renders min and max delay', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      expect(await screen.findByText('1h')).toBeInTheDocument(); // 3600s
      expect(screen.getByText('1d')).toBeInTheDocument();        // 86400s
    });

    it('renders pending change with type and description', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      expect(await screen.findByText('FEE_UPDATE')).toBeInTheDocument();
      expect(screen.getByText(/Update base fee to 80000000 stroops/)).toBeInTheDocument();
    });

    it('shows timelock privileged action warning', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      await screen.findByText('FEE_UPDATE');
      expect(screen.getByText(/scheduling, executing, and cancelling changes are privileged/i)).toBeInTheDocument();
    });
  });

  // ── 4. Network reload ───────────────────────────────────────────────────────

  describe('Network change', () => {
    it('reloads admin state when network prop changes', async () => {
      const { StellarService } = await import('../../services/stellar.service');
      const { rerender } = render(<FactoryAdminPanel network="testnet" />);
      await screen.findByText(ADMIN_ADDRESS);

      rerender(<FactoryAdminPanel network="mainnet" />);

      await waitFor(() => {
        expect(vi.mocked(StellarService)).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ── 5. Privileged actions gated ─────────────────────────────────────────────

  describe('Privileged actions', () => {
    it('renders Transfer Admin button when onPrivilegedAction is provided', async () => {
      const handler = vi.fn();
      render(<FactoryAdminPanel network="testnet" onPrivilegedAction={handler} />);
      const btn = await screen.findByRole('button', { name: /transfer admin/i });
      expect(btn).toBeInTheDocument();
    });

    it('calls onPrivilegedAction with correct action key', async () => {
      const handler = vi.fn();
      render(<FactoryAdminPanel network="testnet" onPrivilegedAction={handler} />);
      const btn = await screen.findByRole('button', { name: /transfer admin/i });
      fireEvent.click(btn);
      expect(handler).toHaveBeenCalledWith('transfer_admin');
    });

    it('does not render privileged buttons without onPrivilegedAction', async () => {
      render(<FactoryAdminPanel network="testnet" />);
      await screen.findByText(ADMIN_ADDRESS);
      expect(screen.queryByRole('button', { name: /transfer admin/i })).not.toBeInTheDocument();
    });

    it('shows disclaimer text near privileged actions', async () => {
      const handler = vi.fn();
      render(<FactoryAdminPanel network="testnet" onPrivilegedAction={handler} />);
      await screen.findByRole('button', { name: /transfer admin/i });
      expect(screen.getByText(/require wallet authentication/i)).toBeInTheDocument();
    });
  });

  // ── 6. Error state ──────────────────────────────────────────────────────────

  describe('Error state', () => {
    it('renders error message when contract read fails', async () => {
      const { StellarService } = await import('../../services/stellar.service');
      vi.mocked(StellarService).mockImplementationOnce(() => ({
        getAdminState: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
        getTreasuryPolicy: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
        getTimelockConfig: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
        getPendingChange: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
      }) as any);

      render(<FactoryAdminPanel network="testnet" />);
      expect(await screen.findByText(/failed to load admin state/i)).toBeInTheDocument();
      expect(screen.getByText(/RPC unavailable/i)).toBeInTheDocument();
    });

    it('shows a retry button on error', async () => {
      const { StellarService } = await import('../../services/stellar.service');
      vi.mocked(StellarService).mockImplementationOnce(() => ({
        getAdminState: vi.fn().mockRejectedValue(new Error('timeout')),
        getTreasuryPolicy: vi.fn().mockRejectedValue(new Error('timeout')),
        getTimelockConfig: vi.fn().mockRejectedValue(new Error('timeout')),
        getPendingChange: vi.fn().mockRejectedValue(new Error('timeout')),
      }) as any);

      render(<FactoryAdminPanel network="testnet" />);
      expect(await screen.findByText(/try again/i)).toBeInTheDocument();
    });
  });
});
