/**
 * Governance Proposal List Component
 * Displays governance proposals from backend governance APIs.
 * 
 * Issue: #617 - Add Governance Read Integration to Frontend Dashboard
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card } from '../UI/Card';
import { Spinner } from '../UI/Spinner';
import { Button } from '../UI/Button';
import { truncateAddress } from '../../utils/formatting';
import {
    fetchProposals,
    type ProposalParams,
} from '../../services/governanceApi';
import { ProposalStatus } from '../../types';
import type { GovernanceProposal } from '../../types';

export interface ProposalListProps {
    /** Props for the proposal list; date filters are controlled inside the component. */
    status?: ProposalStatus;
    /** Filter by creator */
    creator?: string;
    /** Number of items per page */
    limit?: number;
    /** Callback when proposal is selected */
    onProposalSelect?: (proposal: GovernanceProposal) => void;
}

/**
 * Status filter options
 */
const STATUS_OPTIONS: { value: ProposalStatus | ''; label: string }[] = [
    { value: '', label: 'All' },
    { value: ProposalStatus.ACTIVE, label: 'Active' },
    { value: ProposalStatus.PASSED, label: 'Passed' },
    { value: ProposalStatus.REJECTED, label: 'Rejected' },
    { value: ProposalStatus.EXECUTED, label: 'Executed' },
    { value: ProposalStatus.CANCELLED, label: 'Cancelled' },
    { value: ProposalStatus.EXPIRED, label: 'Expired' },
];

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

/**
 * Format time remaining
 */
function getTimeRemaining(endsAt: number): string {
    const now = Date.now();
    const diff = endsAt - now;
    
    if (diff <= 0) return 'Ended';
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    if (days > 0) return `${days}d ${hours}h left`;
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `${hours}h ${minutes}m left`;
    return `${minutes}m left`;
}

function toIsoDate(value: string, endOfDay = false): string {
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    return new Date(`${value}${suffix}`).toISOString();
}

export function ProposalList({
    status,
    creator,
    limit = 10,
    onProposalSelect,
}: ProposalListProps) {
    const [proposals, setProposals] = useState<GovernanceProposal[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [statusFilter, setStatusFilter] = useState<ProposalStatus | ''>(status || '');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const dateRangeRef = useRef({ startDate: '', endDate: '' });
    const previousDateRangeRef = useRef({ startDate: '', endDate: '' });
    const dateFetchTimeoutRef = useRef<number | null>(null);

    useEffect(() => {
        dateRangeRef.current = { startDate, endDate };
    }, [startDate, endDate]);

    const clearDateFetchTimeout = useCallback(() => {
        if (dateFetchTimeoutRef.current !== null) {
            window.clearTimeout(dateFetchTimeoutRef.current);
            dateFetchTimeoutRef.current = null;
        }
    }, []);

    /**
     * Fetch proposals from backend
     */
    const fetchData = useCallback(async (page: number, dateRange = dateRangeRef.current) => {
        clearDateFetchTimeout();
        setLoading(true);
        setError(null);

        try {
            const params: ProposalParams = {
                page,
                limit,
                sortBy: 'createdAt',
                sortOrder: 'desc',
            };

            if (statusFilter) {
                params.status = statusFilter;
            }
            if (creator) {
                params.creator = creator;
            }
            if (dateRange.startDate) {
                params.startDate = toIsoDate(dateRange.startDate);
            }
            if (dateRange.endDate) {
                params.endDate = toIsoDate(dateRange.endDate, true);
            }

            const response = await fetchProposals(params);
            setProposals(response.proposals);
            setTotalPages(response.totalPages);
            setCurrentPage(response.page);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch proposals');
        } finally {
            setLoading(false);
        }
    }, [statusFilter, creator, limit, clearDateFetchTimeout]);

    // Fetch on filter change
    useEffect(() => {
        fetchData(1);
    }, [fetchData]);

    useEffect(() => {
        if (
            previousDateRangeRef.current.startDate === startDate &&
            previousDateRangeRef.current.endDate === endDate
        ) {
            return;
        }

        previousDateRangeRef.current = { startDate, endDate };

        clearDateFetchTimeout();

        dateFetchTimeoutRef.current = window.setTimeout(() => {
            fetchData(1);
        }, 400);

        return () => clearDateFetchTimeout();
    }, [startDate, endDate, fetchData, clearDateFetchTimeout]);

    /**
     * Handle page change
     */
    const handlePageChange = (page: number) => {
        fetchData(page);
    };

    /**
     * Handle proposal click
     */
    const handleProposalClick = (proposal: GovernanceProposal) => {
        onProposalSelect?.(proposal);
    };

    const handleClearDates = () => {
        setStartDate('');
        setEndDate('');
    };

    return (
        <Card className="p-4">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Governance Proposals</h2>

            {/* Status filter */}
            <div className="flex flex-wrap gap-2 mb-4">
                {STATUS_OPTIONS.map((opt) => (
                    <button
                        key={opt.value}
                        onClick={() => setStatusFilter(opt.value)}
                        className={`px-3 py-1 text-sm rounded-full transition-colors ${
                            statusFilter === opt.value
                                ? 'bg-blue-600 text-white'
                                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {/* Date filters */}
            <div className="grid gap-3 mb-4 md:grid-cols-[repeat(3,minmax(0,12rem))] items-end">
                <label className="block">
                    <span className="block text-sm font-medium text-gray-700 mb-1">From</span>
                    <input
                        type="date"
                        value={startDate}
                        onChange={(event) => setStartDate(event.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                </label>
                <label className="block">
                    <span className="block text-sm font-medium text-gray-700 mb-1">To</span>
                    <input
                        type="date"
                        value={endDate}
                        onChange={(event) => setEndDate(event.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                </label>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClearDates}
                    disabled={!startDate && !endDate}
                >
                    Clear dates
                </Button>
            </div>

            {/* Loading state */}
            {loading && (
                <div className="flex justify-center py-8">
                    <Spinner size="lg" />
                </div>
            )}

            {/* Error state */}
            {error && (
                <div className="text-center py-8">
                    <p className="text-red-600 mb-4">{error}</p>
                    <Button variant="outline" onClick={() => fetchData(currentPage)}>
                        Try Again
                    </Button>
                </div>
            )}

            {/* Proposal list */}
            {!loading && !error && (
                <div className="space-y-4">
                    {proposals.length === 0 ? (
                        <div className="text-center py-8 text-gray-500">
                            No proposals found
                        </div>
                    ) : (
                        proposals.map((proposal) => (
                            <div
                                key={proposal.id}
                                onClick={() => handleProposalClick(proposal)}
                                className="p-4 border rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
                            >
                                <div className="flex items-start justify-between mb-2">
                                    <div>
                                        <h3 className="font-medium text-gray-900">
                                            {proposal.title}
                                        </h3>
                                        <p className="text-sm text-gray-500 mt-1">
                                            {proposal.description.substring(0, 100)}...
                                        </p>
                                    </div>
                                    <span
                                        className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusBadge(proposal.status)}`}
                                    >
                                        {proposal.status}
                                    </span>
                                </div>

                                <div className="flex items-center justify-between text-sm text-gray-500 mt-3">
                                    <div className="flex items-center gap-4">
                                        <span>
                                            By: {truncateAddress(proposal.creator)}
                                        </span>
                                        <span>
                                            Votes: {proposal.voteCount}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        {proposal.status === ProposalStatus.ACTIVE && (
                                            <span className="text-blue-600">
                                                {getTimeRemaining(proposal.votingEndsAt)}
                                            </span>
                                        )}
                                        <span>
                                            {new Date(proposal.createdAt).toLocaleDateString()}
                                        </span>
                                    </div>
                                </div>

                                {/* Vote progress bar */}
                                {proposal.status === ProposalStatus.ACTIVE && (
                                    <div className="mt-3">
                                        <div className="flex justify-between text-xs text-gray-500 mb-1">
                                            <span>For: {proposal.votesFor}</span>
                                            <span>Against: {proposal.votesAgainst}</span>
                                        </div>
                                        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-green-500"
                                                style={{
                                                    width: `${(parseInt(proposal.votesFor) / (parseInt(proposal.votesFor) + parseInt(proposal.votesAgainst))) * 100}%`,
                                                }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-4">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={currentPage === 1}
                        onClick={() => handlePageChange(currentPage - 1)}
                    >
                        Previous
                    </Button>
                    <span className="text-sm text-gray-600">
                        Page {currentPage} of {totalPages}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={currentPage === totalPages}
                        onClick={() => handlePageChange(currentPage + 1)}
                    >
                        Next
                    </Button>
                </div>
            )}
        </Card>
    );
}

export default ProposalList;