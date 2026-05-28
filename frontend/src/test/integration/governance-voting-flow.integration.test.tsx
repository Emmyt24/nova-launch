/**
 * Integration test: Governance voting flow (#1088)
 *
 * Covers:
 *  1. Proposal details render correctly
 *  2. Casting a vote calls the API and updates the tally
 *  3. Duplicate-vote attempt is handled gracefully
 *  4. API failure during voting shows an error
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProposalDetail } from '../../components/Governance/ProposalDetail';
import * as governanceApi from '../../services/governanceApi';
import type { GovernanceProposal, GovernanceVote, WalletState } from '../../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const WALLET: WalletState = {
  connected: true,
  address: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
  network: 'testnet',
};

const PROPOSAL: GovernanceProposal = {
  id: 'prop-001',
  title: 'Increase base fee to 10 XLM',
  description: 'This proposal increases the base deployment fee from 7 XLM to 10 XLM.',
  status: 'active' as any,
  creator: 'GCREATOR000000000000000000000000000000000000000000000001',
  voteCount: 2,
  votesFor: '600000',
  votesAgainst: '200000',
  votesAbstain: '0',
  createdAt: Date.now() - 86400_000,
  votingStartsAt: Date.now() - 3600_000,
  votingEndsAt: Date.now() + 86400_000,
  payloadType: 'FEE_CHANGE',
  payload: '{}',
};

const VOTES: GovernanceVote[] = [
  {
    id: 'vote-1',
    proposalId: 'prop-001',
    voter: 'GVOTER1000000000000000000000000000000000000000000000001',
    support: true,
    weight: '600000',
    timestamp: Date.now() - 1800_000,
    txHash: 'tx-vote-1',
  },
  {
    id: 'vote-2',
    proposalId: 'prop-001',
    voter: 'GVOTER2000000000000000000000000000000000000000000000001',
    support: false,
    weight: '200000',
    timestamp: Date.now() - 900_000,
    txHash: 'tx-vote-2',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setupApiMocks(overrides: Partial<{
  proposal: GovernanceProposal;
  votes: GovernanceVote[];
  submitVoteResult: { txHash: string; voteId: string };
  submitVoteError: Error;
}> = {}) {
  const proposal = overrides.proposal ?? PROPOSAL;
  const votes = overrides.votes ?? VOTES;

  vi.spyOn(governanceApi, 'fetchProposal').mockResolvedValue(proposal);
  vi.spyOn(governanceApi, 'fetchProposalVotes').mockResolvedValue({
    votes,
    total: votes.length,
    page: 1,
    limit: 20,
  });
  vi.spyOn(governanceApi, 'fetchExecutionHistory').mockResolvedValue({
    executions: [],
    total: 0,
  });

  const submitVoteSpy = overrides.submitVoteError
    ? vi.spyOn(governanceApi, 'submitVote').mockRejectedValue(overrides.submitVoteError)
    : vi.spyOn(governanceApi, 'submitVote').mockResolvedValue(
        overrides.submitVoteResult ?? { txHash: 'tx-new-vote', voteId: 'vote-new' }
      );

  return { submitVoteSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Governance voting flow — integration (#1088)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Proposal details render ─────────────────────────────────────────────
  it('renders proposal title, description, and vote tally', async () => {
    setupApiMocks();

    render(
      <ProposalDetail proposalId="prop-001" wallet={WALLET} />
    );

    await waitFor(() => {
      expect(screen.getByText('Increase base fee to 10 XLM')).toBeInTheDocument();
    });

    expect(
      screen.getByText(/This proposal increases the base deployment fee/i)
    ).toBeInTheDocument();

    // Vote counts — rendered as "For: 600000" and "Against: 200000"
    expect(screen.getAllByText(/600000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/200000/).length).toBeGreaterThan(0);

    // Individual vote rows
    const forBadge = screen.getAllByText('For');
    expect(forBadge.length).toBeGreaterThanOrEqual(1);
  });

  // ── 2. Cast a vote → tally updates ────────────────────────────────────────
  it('calls submitVote with correct args and refreshes tally on success', async () => {
    const { submitVoteSpy } = setupApiMocks();

    // After voting, return updated proposal with higher for-votes
    const updatedProposal: GovernanceProposal = {
      ...PROPOSAL,
      votesFor: '700000',
      voteCount: 3,
    };
    const fetchProposalSpy = vi.spyOn(governanceApi, 'fetchProposal')
      .mockResolvedValueOnce(PROPOSAL)   // initial load
      .mockResolvedValueOnce(updatedProposal); // after vote

    const user = userEvent.setup();

    render(
      <ProposalDetail
        proposalId="prop-001"
        wallet={WALLET}
        onVoteSubmitted={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Vote For/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Vote For/i }));

    await waitFor(() => {
      expect(submitVoteSpy).toHaveBeenCalledWith('prop-001', true, WALLET);
    });

    // Proposal is re-fetched after voting
    await waitFor(() => {
      expect(fetchProposalSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── 3. Duplicate-vote handled gracefully ──────────────────────────────────
  it('shows an error message when a duplicate vote is rejected', async () => {
    setupApiMocks({
      submitVoteError: new Error('Voter has already voted on this proposal'),
    });

    const user = userEvent.setup();

    render(<ProposalDetail proposalId="prop-001" wallet={WALLET} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Vote For/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Vote For/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Voter has already voted on this proposal/i)
      ).toBeInTheDocument();
    });
  });

  // ── 4. API failure during voting ──────────────────────────────────────────
  it('displays an error when the vote API call fails', async () => {
    setupApiMocks({
      submitVoteError: new Error('Network error: failed to submit vote'),
    });

    const user = userEvent.setup();

    render(<ProposalDetail proposalId="prop-001" wallet={WALLET} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Vote Against/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Vote Against/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Network error: failed to submit vote/i)
      ).toBeInTheDocument();
    });
  });

  // ── 5. Disconnected wallet hides voting buttons ────────────────────────────
  it('does not show voting buttons when wallet is disconnected', async () => {
    setupApiMocks();

    const disconnectedWallet: WalletState = {
      connected: false,
      address: null,
      network: 'testnet',
    };

    render(
      <ProposalDetail proposalId="prop-001" wallet={disconnectedWallet} />
    );

    await waitFor(() => {
      expect(screen.getByText('Increase base fee to 10 XLM')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /Vote For/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Vote Against/i })).not.toBeInTheDocument();
  });
});
