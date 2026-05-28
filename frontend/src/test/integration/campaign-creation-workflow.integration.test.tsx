/**
 * Integration test: Campaign creation workflow (#1087)
 *
 * Covers:
 *  1. Full happy-path: form entry → submit → confirmation UI
 *  2. API client called with the expected payload
 *  3. Server-error response path
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CampaignCreationForm } from '../../components/CampaignForm/CampaignCreationForm';
import { CampaignService } from '../../services/campaignService';

// Prevent StellarService constructor from throwing due to invalid test contract ID
vi.mock('../../services/stellar.service', () => ({
  StellarService: vi.fn(function () { return {}; }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TOKEN_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const WALLET_ADDRESS = 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B';

const CONNECTED_WALLET = {
  wallet: { connected: true, address: WALLET_ADDRESS, network: 'testnet' as const },
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnecting: false,
  error: null,
};

const SUCCESS_RESULT = {
  campaignId: 'campaign_test_001',
  transactionHash: 'a'.repeat(64),
  timestamp: Date.now(),
  totalCost: '0.6',
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../hooks/useWallet', () => ({
  useWallet: vi.fn(() => CONNECTED_WALLET),
}));

vi.mock('../../providers/ToastProvider', () => ({
  useToastContext: vi.fn(() => ({ error: vi.fn(), success: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function fillValidForm(_user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(screen.getByPlaceholderText(/Summer Token Promotion/i), {
    target: { value: 'Summer Token Promotion' },
  });
  fireEvent.change(screen.getByPlaceholderText(/Describe your campaign goals/i), {
    target: { value: 'A detailed description of the summer token promotion campaign' },
  });
  fireEvent.change(screen.getByPlaceholderText('1000.5'), {
    target: { value: '1000' },
  });
  // Set slippage to 0 — the default value of 5 fails the modulo precision check
  fireEvent.change(screen.getByPlaceholderText('5'), {
    target: { value: '0' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Campaign creation workflow — integration (#1087)', () => {
  let createCampaignSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createCampaignSpy = vi
      .spyOn(CampaignService.prototype, 'createCampaign')
      .mockResolvedValue(SUCCESS_RESULT);
  });

  // ── 1. Happy path ──────────────────────────────────────────────────────────
  it('renders the form and submits valid data', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();

    render(
      <CampaignCreationForm tokenAddress={TOKEN_ADDRESS} onSuccess={onSuccess} />
    );

    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: /Create Campaign/i }));

    await waitFor(() => {
      expect(createCampaignSpy).toHaveBeenCalledOnce();
    });
  });

  // ── 2. Payload assertion ───────────────────────────────────────────────────
  it('calls the API client with the expected payload', async () => {
    const user = userEvent.setup();

    render(<CampaignCreationForm tokenAddress={TOKEN_ADDRESS} />);

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /Create Campaign/i }));

    await waitFor(() => expect(createCampaignSpy).toHaveBeenCalledOnce());

    const [payload] = createCampaignSpy.mock.calls[0];
    expect(payload).toMatchObject({
      title: 'Summer Token Promotion',
      description: 'A detailed description of the summer token promotion campaign',
      budget: '1000',
      slippage: 0,
      creatorAddress: WALLET_ADDRESS,
      tokenAddress: TOKEN_ADDRESS,
    });
    expect(payload.duration).toBeGreaterThanOrEqual(3600);
  });

  // ── 3. Confirmation UI on success ─────────────────────────────────────────
  it('renders confirmation UI after successful submission', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();

    render(
      <CampaignCreationForm tokenAddress={TOKEN_ADDRESS} onSuccess={onSuccess} />
    );

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /Create Campaign/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/Success/i).length).toBeGreaterThan(0);
    });

    expect(onSuccess).toHaveBeenCalledWith(
      SUCCESS_RESULT.campaignId,
      SUCCESS_RESULT.transactionHash
    );
  });

  // ── 4. Server-error path ───────────────────────────────────────────────────
  it('displays an error alert when the server returns an error', async () => {
    createCampaignSpy.mockRejectedValueOnce(new Error('Internal server error'));

    const user = userEvent.setup();
    const onError = vi.fn();

    render(
      <CampaignCreationForm tokenAddress={TOKEN_ADDRESS} onError={onError} />
    );

    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: /Create Campaign/i }));

    await waitFor(() => {
      expect(screen.getByText(/Campaign Creation Failed/i)).toBeInTheDocument();
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── 5. Wallet-disconnected guard ───────────────────────────────────────────
  it('disables submit and shows wallet warning when wallet is disconnected', async () => {
    const { useWallet } = await import('../../hooks/useWallet');
    vi.mocked(useWallet).mockReturnValueOnce({
      ...CONNECTED_WALLET,
      wallet: { connected: false, address: null, network: 'testnet' },
    });

    render(<CampaignCreationForm tokenAddress={TOKEN_ADDRESS} />);

    expect(screen.getByText(/Wallet Required/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Campaign/i })).toBeDisabled();
  });
});
