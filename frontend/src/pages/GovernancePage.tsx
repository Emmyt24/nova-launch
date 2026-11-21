/**
 * Governance Page
 * Lists proposals and conditionally shows a "Create Proposal" button for
 * token holders who have governance power.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ProposalList } from '../components/Governance/ProposalList';
import { ProposalDetail } from '../components/Governance/ProposalDetail';
import { CreateProposalForm } from '../components/Governance/CreateProposalForm';
import { VotingPowerBreakdown } from '../components/Governance/VotingPowerBreakdown';
import { Button } from '../components/UI/Button';
import { useGovernance } from '../hooks/useGovernance';
import type { GovernanceProposal, WalletState } from '../types';

interface GovernancePageProps {
  wallet: WalletState;
}

export function GovernancePage({ wallet }: GovernancePageProps) {
  const { t } = useTranslation();
  const [selectedProposal, setSelectedProposal] = useState<GovernanceProposal | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [hasGovernancePower, setHasGovernancePower] = useState(false);
  const [listKey, setListKey] = useState(0);

  // Use an empty string as placeholder; in production pass the real token address
  const { checkGovernancePower, voterInfo, isLoadingVoterInfo } = useGovernance('');

  useEffect(() => {
    if (!wallet.connected) {
      setHasGovernancePower(false);
      return;
    }
    checkGovernancePower(wallet).then(setHasGovernancePower).catch(() => {
      setHasGovernancePower(false);
    });
  }, [wallet, wallet.connected, wallet.address, checkGovernancePower]);

  if (showCreateForm) {
    return (
      <div className="max-w-2xl mx-auto py-8 px-4">
        <CreateProposalForm
          tokenAddress=""
          wallet={wallet}
          onCancel={() => setShowCreateForm(false)}
          onSuccess={(_proposalId, _txHash) => {
            setShowCreateForm(false);
            setListKey((k) => k + 1);
          }}
        />
      </div>
    );
  }

  if (selectedProposal) {
    return (
      <div className="max-w-3xl mx-auto py-8 px-4">
        <ProposalDetail
          proposalId={selectedProposal.id}
          wallet={wallet}
          onBack={() => setSelectedProposal(null)}
        />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-4">
        <h1 data-testid="governance-heading" className="text-2xl font-bold text-gray-900">
          {t('governance.title')}
        </h1>
        {wallet.connected && hasGovernancePower && (
          <Button variant="primary" onClick={() => setShowCreateForm(true)}>
            Create Proposal
          </Button>
        )}
      </div>

      {wallet.connected && (
        <div className="mb-4">
          <VotingPowerBreakdown voterInfo={voterInfo} loading={isLoadingVoterInfo} />
        </div>
      )}

      <ProposalList
        key={listKey}
        onProposalSelect={(proposal) => setSelectedProposal(proposal)}
      />
    </div>
  );
}

export default GovernancePage;
