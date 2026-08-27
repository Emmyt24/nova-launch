/**
 * Governance Proposal Detail Component
 * Displays detailed view of a governance proposal with votes.
 * 
 * Issue: #617 - Add Governance Read Integration to Frontend Dashboard
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card } from '../UI/Card';
import { Spinner } from '../UI/Spinner';
import { Button } from '../UI/Button';
import { truncateAddress } from '../../utils/formatting';
import {
    fetchProposal,
    fetchProposalVotes,
    submitVote,
    fetchExecutionHistory,
    type ExecutionEntry,
} from '../../services/governanceApi';
import { ProposalStatus } from '../../types';
import type { GovernanceProposal, GovernanceVote, WalletState } from '../../types';

export interface ProposalDetailProps {
    /** Proposal ID */
    proposalId: string;
    /** Connected wallet */
    wallet: WalletState;
    /** Callback when vote is submitted */
    onVoteSubmitted?: (proposalId: string, support: boolean) => void;
    /** Callback to go back */
    onBack?: () => void;
}

/**
 * Get status badge color
 */
function getStatusBadge(status: ProposalStatus): string {
    switch (status) {
        case ProposalStatus.ACTIVE:
            return 'bg-blue-100 text-blue-700';
        case ProposalStatus.PASSED:
            return 'bg-green-100 text-green-700';
        case ProposalStatus.REJECTED:
            return 'bg-red-100 text-red-700';
        case ProposalStatus.EXECUTED:
            return 'bg-purple-100 text-purple-700';
        case ProposalStatus.CANCELLED:
            return 'bg-yellow-100 text-yellow-700';
        case ProposalStatus.EXPIRED:
            return 'bg-gray-100 text-gray-700';
        default:
            return 'bg-gray-100 text-gray-700';
    }
}

export function ProposalDetail({
    proposalId,
    wallet,
    onVoteSubmitted,
    onBack,
}: ProposalDetailProps) {
    const [proposal, setProposal] = useState<GovernanceProposal | null>(null);
    const [votes, setVotes] = useState<GovernanceVote[]>([]);
    const [executions, setExecutions] = useState<ExecutionEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [voting, setVoting] = useState(false);
    const [activeTab, setActiveTab] = useState<'votes' | 'execution'>('votes');

    /**
     * Fetch proposal details
     */
    const fetchData = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const [proposalData, votesData, executionData] = await Promise.all([
                fetchProposal(proposalId),
                fetchProposalVotes(proposalId, 1, 20),
                fetchExecutionHistory(proposalId, 1, 5),
            ]);

            setProposal(proposalData);
            setVotes(votesData.votes);
            setExecutions(executionData.executions);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch proposal details');
        } finally {
            setLoading(false);
        }
    }, [proposalId]);

    // Fetch on mount
    useEffect(() => {
        fetchData();
    }, [fetchData]);

    // Poll for live vote updates every 5 seconds while proposal is active
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    useEffect(() => {
        if (proposal?.status !== ProposalStatus.ACTIVE) return;
        pollRef.current = setInterval(async () => {
            try {
                const [proposalData, votesData] = await Promise.all([
                    fetchProposal(proposalId),
                    fetchProposalVotes(proposalId, 1, 20),
                ]);
                setProposal(proposalData);
                setVotes(votesData.votes);
            } catch {
                // silent — don't surface poll errors
            }
        }, 5_000);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [proposal?.status, proposalId]);

    /**
     * Submit a vote
     */
    const handleVote = async (support: boolean) => {
        if (!wallet.connected) {
            setError('Please connect your wallet to vote');
            return;
        }

        setVoting(true);
        setError(null);

        try {
            const result = await submitVote(proposalId, support, wallet);
            console.log('Vote submitted:', result);
            onVoteSubmitted?.(proposalId, support);
            // Refresh data after voting
            await fetchData();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to submit vote');
        } finally {
            setVoting(false);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center py-12">
                <Spinner size="lg" />
            </div>
        );
    }

    if (error || !proposal) {
        return (
            <Card className="p-4">
                <div className="text-center py-8">
                    <p className="text-red-600 mb-4">{error || 'Proposal not found'}</p>
                    {onBack && (
                        <Button variant="outline" onClick={onBack}>
                            Back to Proposals
                        </Button>
                    )}
                </div>
            </Card>
        );
    }

    const totalVotes = parseInt(proposal.votesFor) + parseInt(proposal.votesAgainst);
    const forPercentage = totalVotes > 0 ? (parseInt(proposal.votesFor) / totalVotes) * 100 : 0;
    const againstPercentage = totalVotes > 0 ? (parseInt(proposal.votesAgainst) / totalVotes) * 100 : 0;

    return (
        <Card className="p-4">
            {/* Back button */}
            {onBack && (
                <button
                    onClick={onBack}
                    className="text-blue-600 hover:text-blue-700 mb-4"
                >
                    ← Back to Proposals
                </button>
            )}

            {/* Header */}
            <div className="flex items-start justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">{proposal.title}</h1>
                    <p className="text-gray-500 mt-1">ID: {proposal.id}</p>
                </div>
                <span
                    className={`px-3 py-1 text-sm font-medium rounded-full ${getStatusBadge(proposal.status)}`}
                >
                    {proposal.status}
                </span>
            </div>

            {/* Description */}
            <div className="mb-6">
                <h2 className="text-lg font-medium text-gray-900 mb-2">Description</h2>
                <p className="text-gray-600 whitespace-pre-wrap">{proposal.description}</p>
            </div>

            {/* Proposal info */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="p-3 bg-gray-50 rounded-lg">
                    <div className="text-sm text-gray-500">Creator</div>
                    <div className="font-medium">{truncateAddress(proposal.creator)}</div>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                    <div className="text-sm text-gray-500">Created</div>
                    <div className="font-medium">
                        {new Date(proposal.createdAt).toLocaleDateString()}
                    </div>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                    <div className="text-sm text-gray-500">Voters</div>
                    <div className="font-medium">{proposal.voteCount}</div>
                </div>
            </div>

            {/* Vote progress */}
            <div className="mb-6">
                <h2 className="text-lg font-medium text-gray-900 mb-3">Vote Progress</h2>
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                        <span className="text-green-600 font-medium">For: {proposal.votesFor}</span>
                        <span className="text-gray-600">{forPercentage.toFixed(1)}%</span>
                    </div>
                    <div className="h-4 bg-gray-200 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-green-500"
                            style={{ width: `${forPercentage}%` }}
                        />
                    </div>
                    <div className="flex items-center justify-between text-sm mt-2">
                        <span className="text-red-600 font-medium">Against: {proposal.votesAgainst}</span>
                        <span className="text-gray-600">{againstPercentage.toFixed(1)}%</span>
                    </div>
                    <div className="h-4 bg-gray-200 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-red-500"
                            style={{ width: `${againstPercentage}%` }}
                        />
                    </div>
                </div>
            </div>

            {/* Voting buttons */}
            {proposal.status === ProposalStatus.ACTIVE && wallet.connected && (
                <div className="mb-6 p-4 bg-blue-50 rounded-lg">
                    <h3 className="font-medium text-gray-900 mb-3">Cast Your Vote</h3>
                    <div className="flex gap-3">
                        <Button
                            variant="primary"
                            onClick={() => handleVote(true)}
                            disabled={voting}
                            className="flex-1"
                        >
                            {voting ? 'Submitting...' : 'Vote For'}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => handleVote(false)}
                            disabled={voting}
                            className="flex-1"
                        >
                            {voting ? 'Submitting...' : 'Vote Against'}
                        </Button>
                    </div>
                </div>
            )}

            {/* Tabs for votes and execution */}
            <div className="border-t pt-4">
                <div className="flex gap-4 mb-4">
                    <button
                        onClick={() => setActiveTab('votes')}
                        className={`pb-2 font-medium ${
                            activeTab === 'votes'
                                ? 'text-blue-600 border-b-2 border-blue-600'
                                : 'text-gray-500'
                        }`}
                    >
                        Votes ({votes.length})
                    </button>
                    {proposal.status === ProposalStatus.EXECUTED && (
                        <button
                            onClick={() => setActiveTab('execution')}
                            className={`pb-2 font-medium ${
                                activeTab === 'execution'
                                    ? 'text-blue-600 border-b-2 border-blue-600'
                                    : 'text-gray-500'
                            }`}
                        >
                            Execution History
                        </button>
                    )}
                </div>

                {/* Votes tab */}
                {activeTab === 'votes' && (
                    <div className="space-y-2">
                        {votes.length === 0 ? (
                            <p className="text-gray-500 text-center py-4">No votes yet</p>
                        ) : (
                            votes.map((vote) => (
                                <div
                                    key={vote.id}
                                    className="flex items-center justify-between p-3 bg-gray-50 rounded"
                                >
                                    <div>
                                        <span className="font-medium">
                                            {truncateAddress(vote.voter)}
                                        </span>
                                        <span className="text-gray-500 text-sm ml-2">
                                            • {vote.weight} votes
                                        </span>
                                    </div>
                                    <span
                                        className={`px-2 py-1 text-xs font-medium rounded ${
                                            vote.support
                                                ? 'bg-green-100 text-green-700'
                                                : 'bg-red-100 text-red-700'
                                        }`}
                                    >
                                        {vote.support ? 'For' : 'Against'}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                )}

                {/* Execution tab */}
                {activeTab === 'execution' && (
                    <div className="space-y-2">
                        {executions.length === 0 ? (
                            <p className="text-gray-500 text-center py-4">No execution history</p>
                        ) : (
                            executions.map((exec) => (
                                <div
                                    key={exec.id}
                                    className="p-3 bg-gray-50 rounded"
                                >
                                    <div className="flex items-center justify-between">
                                        <span className="font-medium">Execution {exec.id}</span>
                                        <span
                                            className={`px-2 py-1 text-xs font-medium rounded ${
                                                exec.status === 'success'
                                                    ? 'bg-green-100 text-green-700'
                                                    : 'bg-red-100 text-red-700'
                                            }`}
                                        >
                                            {exec.status}
                                        </span>
                                    </div>
                                    <div className="text-sm text-gray-500 mt-1">
                                        {new Date(exec.timestamp).toLocaleString()}
                                    </div>
                                    {exec.error && (
                                        <div className="text-sm text-red-600 mt-1">
                                            Error: {exec.error}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>
        </Card>
    );
}

export default ProposalDetail;