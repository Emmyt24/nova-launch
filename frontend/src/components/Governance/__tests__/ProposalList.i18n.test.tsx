import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import i18n from '../../../i18n/config';
import en from '../../../i18n/locales/en.json';
import fr from '../../../i18n/locales/fr.json';
import { ProposalList } from '../ProposalList';
import { GovernancePage } from '../../../pages/GovernancePage';
import * as governanceApi from '../../../services/governanceApi';
import type { WalletState } from '../../../types';

vi.mock('../../../hooks/useGovernance', () => ({
    useGovernance: () => ({ checkGovernancePower: vi.fn().mockResolvedValue(false) }),
}));

const FILTER_KEYS = [
    'all',
    'active',
    'passed',
    'rejected',
    'executed',
    'cancelled',
    'expired',
] as const;

const disconnectedWallet: WalletState = { connected: false, address: null, network: 'testnet' };

describe('Governance i18n', () => {
    beforeEach(() => {
        vi.spyOn(governanceApi, 'fetchProposals').mockResolvedValue({
            proposals: [],
            total: 0,
            page: 1,
            limit: 10,
            totalPages: 1,
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await act(async () => {
            await i18n.changeLanguage('en');
        });
    });

    it('renders English status filter labels through t()', async () => {
        await act(async () => {
            await i18n.changeLanguage('en');
        });
        render(<ProposalList limit={10} />);

        for (const key of FILTER_KEYS) {
            expect(screen.getByTestId(`status-filter-${key}`)).toHaveTextContent(
                en.governance.statusFilter[key]
            );
        }
    });

    it('renders translated status filter labels in a non-English locale', async () => {
        await act(async () => {
            await i18n.changeLanguage('fr');
        });
        render(<ProposalList limit={10} />);

        for (const key of FILTER_KEYS) {
            const button = screen.getByTestId(`status-filter-${key}`);
            expect(button).toHaveTextContent(fr.governance.statusFilter[key]);
            expect(button.textContent).not.toContain('governance.statusFilter');
        }
        expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    });

    it('renders the translated governance page heading', async () => {
        await act(async () => {
            await i18n.changeLanguage('fr');
        });
        render(<GovernancePage wallet={disconnectedWallet} />);

        await waitFor(() => {
            expect(screen.getByTestId('governance-heading')).toHaveTextContent(
                fr.governance.title
            );
        });
        expect(fr.governance.title).not.toBe(en.governance.title);
    });
});
