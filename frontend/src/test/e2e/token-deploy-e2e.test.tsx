/**
 * End-to-end integration test for the token deployment UI flow.
 * Mocks Stellar and IPFS services; exercises the full form → submit → confirm path.
 *
 * Mocked services:
 *   - useTokenDeploy  – controls deploy/status/error state
 *   - useFactoryFees  – returns fixed fee values
 *   - useFactoryState – returns unpaused state
 *   - analytics       – no-op
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TokenDeployForm } from '../../components/TokenDeployForm/TokenDeployForm';
import type { WalletState } from '../../types';

vi.mock('../../hooks/useTokenDeploy');
vi.mock('../../hooks/useFactoryFees');
vi.mock('../../hooks/useFactoryState');
vi.mock('../../services/analytics', () => ({ analytics: { track: vi.fn() }, AnalyticsEvent: {} }));

import { useTokenDeploy } from '../../hooks/useTokenDeploy';
import { useFactoryFees } from '../../hooks/useFactoryFees';
import { useFactoryState } from '../../hooks/useFactoryState';

const WALLET_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const connectedWallet: WalletState = {
    connected: true,
    address: WALLET_ADDR,
    network: 'testnet',
};

function renderForm(wallet: WalletState = connectedWallet) {
    render(
        <TokenDeployForm
            wallet={wallet}
            onConnectWallet={vi.fn().mockResolvedValue(undefined)}
            isConnectingWallet={false}
        />
    );
}

function fillAndAdvance(adminWallet = WALLET_ADDR) {
    fireEvent.change(screen.getByPlaceholderText(/My Awesome Token/i), { target: { value: 'Test Token' } });
    fireEvent.change(screen.getByPlaceholderText(/MAT/i), { target: { value: 'TTK' } });
    fireEvent.change(screen.getByPlaceholderText(/1000000/i), { target: { value: '500000' } });
    fireEvent.change(screen.getByPlaceholderText(/GXXX/i), { target: { value: adminWallet } });
    fireEvent.click(screen.getByRole('button', { name: /Next Step/i }));
}

const defaultFees = {
    baseFee: 7,
    metadataFee: 3,
    loading: false,
    error: null,
    isFallback: false,
    refresh: vi.fn(),
};

const defaultFactoryState = {
    isPaused: false,
    loading: false,
    error: null,
    lastChecked: null,
    refresh: vi.fn(),
};

const idleDeploy = {
    deploy: vi.fn(),
    retry: vi.fn(),
    reset: vi.fn(),
    status: 'idle' as const,
    statusMessage: '',
    isDeploying: false,
    error: null,
    retryCount: 0,
    canRetry: false,
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFactoryFees).mockReturnValue(defaultFees);
    vi.mocked(useFactoryState).mockReturnValue(defaultFactoryState);
    vi.mocked(useTokenDeploy).mockReturnValue(idleDeploy);
});

// ── Success path ───────────────────────────────────────────────────────────

describe('success path', () => {
    it('calls deploy with the correct arguments when Deploy Token is clicked', async () => {
        const mockDeploy = vi.fn().mockResolvedValue({
            tokenAddress: 'GTOKEN123',
            transactionHash: 'TXHASH456',
            totalFee: '7',
            timestamp: Date.now(),
        });
        vi.mocked(useTokenDeploy).mockReturnValue({ ...idleDeploy, deploy: mockDeploy });

        renderForm();
        fillAndAdvance();

        await waitFor(() => screen.getByText('Review & Deploy'));
        fireEvent.click(screen.getByRole('button', { name: /Deploy Token/i }));

        await waitFor(() => {
            expect(mockDeploy).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'Test Token',
                    symbol: 'TTK',
                    initialSupply: '500000',
                    adminWallet: WALLET_ADDR,
                })
            );
        });
    });

    it('renders the success confirmation UI after deployment', async () => {
        vi.mocked(useTokenDeploy).mockReturnValue({
            ...idleDeploy,
            status: 'success',
            statusMessage: 'Deployment complete.',
        });

        renderForm();
        fillAndAdvance();

        await waitFor(() => {
            expect(screen.getByText(/Deployment complete/i)).toBeInTheDocument();
        });
    });
});

// ── IPFS upload step ───────────────────────────────────────────────────────

describe('IPFS upload step', () => {
    it('shows uploading status message while IPFS upload is in progress', async () => {
        vi.mocked(useTokenDeploy).mockReturnValue({
            ...idleDeploy,
            status: 'uploading',
            statusMessage: 'Uploading metadata to IPFS...',
            isDeploying: true,
        });

        renderForm();
        fillAndAdvance();

        await waitFor(() => {
            expect(screen.getByText('Uploading metadata to IPFS...')).toBeInTheDocument();
        });
    });
});

// ── Validation failure path ────────────────────────────────────────────────

describe('validation failure path', () => {
    it('shows a field error and does not advance when the form is submitted empty', async () => {
        renderForm();
        const form = document.querySelector('form')!;
        fireEvent.submit(form);

        await waitFor(() => {
            expect(screen.getByText(/Token name must be/i)).toBeInTheDocument();
        });
        expect(screen.queryByText('Review & Deploy')).not.toBeInTheDocument();
    });

    it('shows an address error when the admin wallet does not match the connected wallet', async () => {
        const differentAddr = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
        renderForm();
        fillAndAdvance(differentAddr);

        await waitFor(() => screen.getByText('Review & Deploy'));
        fireEvent.click(screen.getByRole('button', { name: /Deploy Token/i }));

        await waitFor(() => {
            expect(screen.getByText(/Admin wallet must match/i)).toBeInTheDocument();
        });
    });
});

// ── Error path ─────────────────────────────────────────────────────────────

describe('error path', () => {
    it('shows the error message and a retry button when deployment fails', async () => {
        vi.mocked(useTokenDeploy).mockReturnValue({
            ...idleDeploy,
            status: 'error',
            statusMessage: 'Deployment failed.',
            error: { code: 'TRANSACTION_FAILED', message: 'Rejected by network' },
            retryCount: 1,
            canRetry: true,
        });

        renderForm();
        fillAndAdvance();

        await waitFor(() => {
            expect(screen.getByText('Deployment Failed')).toBeInTheDocument();
            expect(screen.getByText('Rejected by network')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /Retry Deployment/i })).toBeInTheDocument();
        });
    });
});

// ── Wallet not connected ───────────────────────────────────────────────────

describe('wallet not connected', () => {
    it('disables the deploy button and shows a connect message', async () => {
        const disconnected: WalletState = { connected: false, address: null, network: 'testnet' };
        renderForm(disconnected);
        fillAndAdvance('GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ');

        await waitFor(() => {
            expect(screen.getByText('Connect your wallet to continue deployment.')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /Deploy Token/i })).toBeDisabled();
        });
    });
});
