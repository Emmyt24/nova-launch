import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient, ProposalStatus, ProposalType } from '@prisma/client';
import { GovernanceEventParser } from '../services/governanceEventParser';
import { GovernanceEventMapper } from '../services/governanceEventMapper';

describe('Governance — proposal lifecycle', () => {
  let prisma: PrismaClient;
  let parser: GovernanceEventParser;
  let mapper: GovernanceEventMapper;

  beforeEach(async () => {
    prisma = new PrismaClient();
    parser = new GovernanceEventParser(prisma);
    mapper = new GovernanceEventMapper();
    await prisma.proposalExecution.deleteMany();
    await prisma.vote.deleteMany();
    await prisma.proposal.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it('persists a proposal and transitions it to EXECUTED after a vote and execution', async () => {
    const NOW_S = Math.floor(Date.now() / 1000);

    // 1. Create proposal
    await parser.parseEvent(mapper.mapEvent({
      type: 'contract', ledger: 1, ledger_close_time: new Date().toISOString(),
      contract_id: 'CCONTRACT', id: 'e1', paging_token: 'p1',
      topic: ['prop_cr_v1', 'CTOKEN'],
      value: { proposal_id: 99, proposer: 'GPROPOSER', title: 'Test Proposal',
               proposal_type: 0, start_time: NOW_S, end_time: NOW_S + 86400,
               quorum: 1_000_000, threshold: 500_000 },
      in_successful_contract_call: true, transaction_hash: 'tx-create',
    })!);

    // 2. Cast a vote
    await parser.parseEvent(mapper.mapEvent({
      type: 'contract', ledger: 2, ledger_close_time: new Date().toISOString(),
      contract_id: 'CCONTRACT', id: 'e2', paging_token: 'p2',
      topic: ['vote_cs_v1', '99'],
      value: { proposal_id: 99, voter: 'GVOTER', support: true, weight: 600_000 },
      in_successful_contract_call: true, transaction_hash: 'tx-vote',
    })!);

    // 3. Execute proposal
    await parser.parseEvent(mapper.mapEvent({
      type: 'contract', ledger: 3, ledger_close_time: new Date().toISOString(),
      contract_id: 'CCONTRACT', id: 'e3', paging_token: 'p3',
      topic: ['prop_ex_v1', 'CTOKEN'],
      value: { proposal_id: 99, executor: 'GEXECUTOR', success: true },
      in_successful_contract_call: true, transaction_hash: 'tx-exec',
    })!);

    const proposal = await prisma.proposal.findUnique({
      where: { proposalId: 99 },
      include: { votes: true, executions: true },
    });

    expect(proposal?.proposalType).toBe(ProposalType.PARAMETER_CHANGE);
    expect(proposal?.votes).toHaveLength(1);
    expect(proposal?.votes[0].support).toBe(true);
    expect(proposal?.executions).toHaveLength(1);
    expect(proposal?.status).toBe(ProposalStatus.EXECUTED);
    expect(proposal?.executedAt).not.toBeNull();
  });
});
