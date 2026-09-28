export const compatibilityEnums = {
  ProposalStatus: {
    ACTIVE: "ACTIVE",
    PASSED: "PASSED",
    REJECTED: "REJECTED",
    QUEUED: "QUEUED",
    EXECUTED: "EXECUTED",
    CANCELLED: "CANCELLED",
    EXPIRED: "EXPIRED",
  },
  ProposalType: {
    PARAMETER_CHANGE: "PARAMETER_CHANGE",
    ADMIN_TRANSFER: "ADMIN_TRANSFER",
    TREASURY_SPEND: "TREASURY_SPEND",
    CONTRACT_UPGRADE: "CONTRACT_UPGRADE",
    CUSTOM: "CUSTOM",
  },
  StreamStatus: {
    CREATED: "CREATED",
    CLAIMED: "CLAIMED",
    CANCELLED: "CANCELLED",
  },
} as const;

export type CompatibilitySeedMode = "empty" | "legacy-populated";

type TokenRow = {
  id: string;
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  initialSupply: bigint;
  totalBurned: bigint;
  burnCount: number;
  metadataUri: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type BurnRecordRow = {
  id: string;
  tokenId: string;
  from: string;
  amount: bigint;
  burnedBy: string;
  isAdminBurn: boolean;
  txHash: string;
  timestamp: Date;
};

type AnalyticsRow = {
  id: string;
  tokenId: string;
  date: Date;
  burnVolume: bigint;
  burnCount: number;
  uniqueBurners: number;
  createdAt: Date;
  updatedAt: Date;
};

type UserRow = {
  id: string;
  address: string;
  createdAt: Date;
  lastActive: Date;
};

type CampaignRow = {
  id: string;
  campaignId: number;
  tokenId: string;
  creator: string;
  type: "BUYBACK" | "AIRDROP" | "LIQUIDITY";
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  targetAmount: bigint;
  currentAmount: bigint;
  executionCount: number;
  startTime: Date;
  endTime: Date | null;
  metadata: string | null;
  txHash: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
};

type CampaignExecutionRow = {
  id: string;
  campaignId: string;
  executor: string;
  amount: bigint;
  recipient: string | null;
  txHash: string;
  executedAt: Date;
};

type ProposalRow = {
  id: string;
  proposalId: number;
  tokenId: string;
  proposer: string;
  title: string;
  description: string | null;
  proposalType: string;
  status: string;
  startTime: Date;
  endTime: Date;
  quorum: bigint;
  threshold: bigint;
  metadata: string | null;
  txHash: string;
  createdAt: Date;
  updatedAt: Date;
  executedAt: Date | null;
  cancelledAt: Date | null;
};

type VoteRow = {
  id: string;
  proposalId: string;
  voter: string;
  support: boolean;
  weight: bigint;
  reason: string | null;
  txHash: string;
  timestamp: Date;
};

type ProposalExecutionRow = {
  id: string;
  proposalId: string;
  executor: string;
  success: boolean;
  returnData: string | null;
  gasUsed: bigint | null;
  txHash: string;
  executedAt: Date;
};

type StreamRow = {
  id: string;
  streamId: number;
  creator: string;
  recipient: string;
  amount: bigint;
  metadata: string | null;
  status: string;
  txHash: string;
  createdAt: Date;
  claimedAt: Date | null;
  cancelledAt: Date | null;
};

type CompatibilityState = {
  tokens: TokenRow[];
  burnRecords: BurnRecordRow[];
  analytics: AnalyticsRow[];
  users: UserRow[];
  campaigns: CampaignRow[];
  campaignExecutions: CampaignExecutionRow[];
  proposals: ProposalRow[];
  votes: VoteRow[];
  proposalExecutions: ProposalExecutionRow[];
  streams: StreamRow[];
  sequence: number;
};

const baseDates = {
  seededAt: new Date("2026-03-10T12:00:00.000Z"),
  analyticsDay: new Date("2026-03-08T23:00:00.000Z"),
  governanceStart: new Date("2026-03-12T10:00:00.000Z"),
  governanceEnd: new Date("2026-03-19T10:00:00.000Z"),
  streamCreated: new Date("2026-03-12T08:30:00.000Z"),
  streamClaimed: new Date("2026-03-12T09:30:00.000Z"),
  campaignStart: new Date("2026-03-11T00:00:00.000Z"),
  campaignExecution: new Date("2026-03-12T15:30:00.000Z"),
  campaignCompleted: new Date("2026-03-13T18:30:00.000Z"),
  governanceQueued: new Date("2026-03-19T12:00:00.000Z"),
  governanceExecuted: new Date("2026-03-21T12:00:00.000Z"),
};

/**
 * Build a seeded proposal row for a given lifecycle status. Shared shape keeps
 * each lifecycle fixture focused on the fields that differ per status.
 */
function lifecycleProposal(
  proposalId: number,
  status: string,
  title: string,
  overrides: Partial<ProposalRow> = {}
): ProposalRow {
  const slug = status.toLowerCase();
  return {
    id: `proposal-lifecycle-${slug}`,
    proposalId,
    tokenId: "CTOKENLEGACY001",
    proposer: "GPROPOSERLIFECYCLE001",
    title,
    description: `Seeded ${slug} proposal for governance lifecycle e2e coverage`,
    proposalType: compatibilityEnums.ProposalType.PARAMETER_CHANGE,
    status,
    startTime: baseDates.governanceStart,
    endTime: baseDates.governanceEnd,
    quorum: BigInt("50000"),
    threshold: BigInt("25000"),
    metadata: null,
    txHash: `tx-proposal-lifecycle-${slug}`,
    createdAt: baseDates.governanceStart,
    updatedAt: baseDates.governanceEnd,
    executedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

export const compatibilitySeedData = {
  legacy: {
    token: {
      id: "token-legacy-001",
      address: "CTOKENLEGACY001",
      creator: "GLEGACYCREATOR001",
      name: "Legacy Indexed Token",
      symbol: "LIT",
      decimals: 7,
      totalSupply: BigInt("1000000000"),
      initialSupply: BigInt("1000000000"),
      totalBurned: BigInt("5000"),
      burnCount: 2,
      metadataUri: null,
      createdAt: baseDates.seededAt,
      updatedAt: baseDates.seededAt,
    },
    burnRecord: {
      id: "burn-legacy-001",
      tokenId: "token-legacy-001",
      from: "GBURNERLEGACY001",
      amount: BigInt("5000"),
      burnedBy: "GBURNERLEGACY001",
      isAdminBurn: false,
      txHash: "tx-burn-legacy-001",
      timestamp: baseDates.seededAt,
    },
    analytics: {
      id: "analytics-legacy-001",
      tokenId: "token-legacy-001",
      date: baseDates.analyticsDay,
      burnVolume: BigInt("5000"),
      burnCount: 2,
      uniqueBurners: 2,
      createdAt: baseDates.seededAt,
      updatedAt: baseDates.seededAt,
    },
    campaign: {
      id: "campaign-legacy-001",
      campaignId: 9101,
      tokenId: "CTOKENLEGACY001",
      creator: "GCAMPAIGNLEGACY001",
      type: "BUYBACK" as const,
      status: "ACTIVE" as const,
      targetAmount: BigInt("100000"),
      currentAmount: BigInt("25000"),
      executionCount: 1,
      startTime: baseDates.campaignStart,
      endTime: null,
      metadata: JSON.stringify({ strategy: "laddered-buyback" }),
      txHash: "tx-campaign-legacy-001",
      createdAt: baseDates.campaignStart,
      updatedAt: baseDates.campaignExecution,
      completedAt: null,
      cancelledAt: null,
    },
    campaignExecution: {
      id: "campaign-exec-legacy-001",
      campaignId: "campaign-legacy-001",
      executor: "GEXECUTORLEGACY001",
      amount: BigInt("25000"),
      recipient: "GPOOLLEGACY001",
      txHash: "tx-campaign-exec-legacy-001",
      executedAt: baseDates.campaignExecution,
    },
    proposal: {
      id: "proposal-legacy-001",
      proposalId: 7301,
      tokenId: "CTOKENLEGACY001",
      proposer: "GPROPOSERLEGACY001",
      title: "Legacy Governance Proposal",
      description: null,
      proposalType: compatibilityEnums.ProposalType.PARAMETER_CHANGE,
      status: compatibilityEnums.ProposalStatus.ACTIVE,
      startTime: baseDates.governanceStart,
      endTime: baseDates.governanceEnd,
      quorum: BigInt("50000"),
      threshold: BigInt("25000"),
      metadata: null,
      txHash: "tx-proposal-legacy-001",
      createdAt: baseDates.governanceStart,
      updatedAt: baseDates.governanceStart,
      executedAt: null,
      cancelledAt: null,
    },
    /**
     * One proposal per non-ACTIVE lifecycle status exercised by
     * e2e/governance-lifecycle.spec.ts (passed → queue, queued → execute) plus
     * the terminal states, so those paths run against real seed data instead
     * of being skipped.
     */
    lifecycleProposals: [
      lifecycleProposal(
        7310,
        compatibilityEnums.ProposalStatus.PASSED,
        "Seeded Passed Proposal"
      ),
      lifecycleProposal(
        7311,
        compatibilityEnums.ProposalStatus.QUEUED,
        "Seeded Queued Proposal",
        { updatedAt: baseDates.governanceQueued }
      ),
      lifecycleProposal(
        7312,
        compatibilityEnums.ProposalStatus.EXECUTED,
        "Seeded Executed Proposal",
        {
          updatedAt: baseDates.governanceExecuted,
          executedAt: baseDates.governanceExecuted,
        }
      ),
      lifecycleProposal(
        7313,
        compatibilityEnums.ProposalStatus.REJECTED,
        "Seeded Rejected Proposal"
      ),
    ],
    lifecycleProposalExecution: {
      id: "proposal-exec-lifecycle-executed",
      proposalId: "proposal-lifecycle-executed",
      executor: "GEXECUTORLIFECYCLE001",
      success: true,
      returnData: null,
      gasUsed: BigInt("48000"),
      txHash: "tx-proposal-exec-lifecycle-executed",
      executedAt: baseDates.governanceExecuted,
    },
    vote: {
      id: "vote-legacy-001",
      proposalId: "proposal-legacy-001",
      voter: "GVOTERLEGACY001",
      support: true,
      weight: BigInt("12000"),
      reason: null,
      txHash: "tx-vote-legacy-001",
      timestamp: new Date("2026-03-12T12:30:00.000Z"),
    },
    stream: {
      id: "stream-legacy-001",
      streamId: 8201,
      creator: "GSTREAMCREATOR001",
      recipient: "GSTREAMRECIPIENT001",
      amount: BigInt("42000"),
      metadata: null,
      status: compatibilityEnums.StreamStatus.CREATED,
      txHash: "tx-stream-legacy-001",
      createdAt: baseDates.streamCreated,
      claimedAt: null,
      cancelledAt: null,
    },
  },
  fresh: {
    token: {
      address: "CTOKENFRESH001",
      creator: "GFRESHCREATOR001",
      name: "Fresh Compatibility Token",
      symbol: "FCT",
      decimals: 7,
      totalSupply: BigInt("500000"),
      initialSupply: BigInt("500000"),
      metadataUri: "ipfs://fresh-token-metadata",
    },
  },
  events: {
    tokenBurn: {
      from: "GBURNERNEW001",
      amount: BigInt("2500"),
      burnedBy: "GBURNERNEW001",
      txHash: "tx-burn-new-001",
      isAdminBurn: false,
    },
    campaign: {
      created: {
        campaignId: 9102,
        tokenId: "CTOKENFRESH001",
        creator: "GCAMPAIGNCREATOR002",
        type: "AIRDROP" as const,
        targetAmount: BigInt("88000"),
        startTime: new Date("2026-03-15T00:00:00.000Z"),
        endTime: new Date("2026-03-20T00:00:00.000Z"),
        metadata: JSON.stringify({ tranche: 1 }),
        txHash: "tx-campaign-created-002",
      },
      execution: {
        campaignId: 9101,
        executor: "GCAMPAIGNEXECUTOR002",
        amount: BigInt("5000"),
        recipient: "GAIRDROPPOOL001",
        txHash: "tx-campaign-exec-002",
        executedAt: new Date("2026-03-14T00:00:00.000Z"),
      },
      executionFresh: {
        campaignId: 9102,
        executor: "GCAMPAIGNEXECUTOR003",
        amount: BigInt("15000"),
        recipient: "GAIRDROPPOOL002",
        txHash: "tx-campaign-exec-003",
        executedAt: new Date("2026-03-16T00:00:00.000Z"),
      },
      completed: {
        campaignId: 9102,
        status: "COMPLETED" as const,
        txHash: "tx-campaign-status-002",
      },
      paused: {
        campaignId: 9101,
        status: "PAUSED" as const,
        txHash: "tx-campaign-status-legacy-pause",
      },
    },
    governance: {
      vote: {
        type: "vote_cast" as const,
        proposalId: 7301,
        voter: "GVOTERNEW001",
        support: false,
        weight: "8000",
        reason: "Needs more runway data",
        txHash: "tx-vote-new-001",
        ledger: 400002,
        timestamp: new Date("2026-03-13T11:00:00.000Z"),
        contractId: "CGOVCOMPAT001",
      },
    },
    rawGovernance: [
      {
        type: "contract",
        ledger: 400100,
        ledger_close_time: "2026-03-18T09:00:00.000Z",
        contract_id: "CGOVCOMPAT002",
        id: "event-proposal-created-compat",
        paging_token: "paging-compat-1",
        topic: ["prop_create", "CTOKENFRESH001"],
        value: {
          proposal_id: 7302,
          proposer: "GPROPOSERREPLAY001",
          title: "Replay Governance Proposal",
          description: "Replay should still hydrate the current schema",
          proposal_type: 0,
          start_time: 1773805200,
          end_time: 1774410000,
          quorum: 70000,
          threshold: 35000,
          metadata: JSON.stringify({ replay: true }),
        },
        in_successful_contract_call: true,
        transaction_hash: "tx-proposal-created-replay-001",
      },
      {
        type: "contract",
        ledger: 400101,
        ledger_close_time: "2026-03-18T10:00:00.000Z",
        contract_id: "CGOVCOMPAT002",
        id: "event-vote-compat-1",
        paging_token: "paging-compat-2",
        topic: ["vote_cast", "CTOKENFRESH001"],
        value: {
          proposal_id: 7302,
          voter: "GVOTERREPLAY001",
          support: true,
          weight: 42000,
          reason: "Replay vote support",
        },
        in_successful_contract_call: true,
        transaction_hash: "tx-vote-replay-001",
      },
      {
        type: "contract",
        ledger: 400102,
        ledger_close_time: "2026-03-18T11:00:00.000Z",
        contract_id: "CGOVCOMPAT002",
        id: "event-proposal-status-compat-1",
        paging_token: "paging-compat-3",
        topic: ["prop_status", "CTOKENFRESH001"],
        value: {
          proposal_id: 7302,
          old_status: 0,
          new_status: 1,
        },
        in_successful_contract_call: true,
        transaction_hash: "tx-proposal-status-replay-001",
      },
      {
        type: "contract",
        ledger: 400103,
        ledger_close_time: "2026-03-18T12:00:00.000Z",
        contract_id: "CGOVCOMPAT002",
        id: "event-proposal-executed-compat-1",
        paging_token: "paging-compat-4",
        topic: ["prop_exec", "CTOKENFRESH001"],
        value: {
          proposal_id: 7302,
          executor: "GEXECUTORREPLAY001",
          success: true,
          return_data: "0x01",
          gas_used: 51000,
        },
        in_successful_contract_call: true,
        transaction_hash: "tx-proposal-executed-replay-001",
      },
    ],
    stream: {
      created: {
        type: "created" as const,
        streamId: 8202,
        creator: "GSTREAMCREATOR002",
        recipient: "GSTREAMRECIPIENT002",
        amount: "9500",
        hasMetadata: true,
        metadata: "ipfs://stream-replay-metadata",
        txHash: "tx-stream-created-002",
        timestamp: new Date("2026-03-17T08:00:00.000Z"),
      },
      metadataUpdated: {
        type: "metadata_updated" as const,
        streamId: 8201,
        updater: "GSTREAMCREATOR001",
        hasMetadata: true,
        metadata: "ipfs://legacy-stream-upgraded",
        txHash: "tx-stream-metadata-legacy-001",
        timestamp: new Date("2026-03-13T09:00:00.000Z"),
      },
      claimed: {
        type: "claimed" as const,
        streamId: 8202,
        recipient: "GSTREAMRECIPIENT002",
        amount: "9500",
        txHash: "tx-stream-claimed-002",
        timestamp: new Date("2026-03-17T12:00:00.000Z"),
      },
    },
  },
};

function cloneValue<T>(value: T): T {
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  if (typeof value === "bigint") {
    return BigInt(value.toString()) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>
    )) {
      output[key] = cloneValue(inner);
    }
    return output as T;
  }

  return value;
}

function normalizeDate(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function matchesWhere<T extends Record<string, any>>(
  row: T,
  where?: Record<string, any>
): boolean {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([key, value]) => {
    const fieldValue = row[key as keyof T];

    if (value && typeof value === "object" && "in" in value) {
      return value.in.includes(fieldValue);
    }

    return fieldValue === value;
  });
}

function sortRows<T extends Record<string, any>>(
  rows: T[],
  orderBy?: Record<string, "asc" | "desc">
): T[] {
  if (!orderBy) {
    return rows;
  }

  const [field, direction] = Object.entries(orderBy)[0];
  const factor = direction === "desc" ? -1 : 1;

  return [...rows].sort((left, right) => {
    const leftValue = left[field];
    const rightValue = right[field];

    if (leftValue instanceof Date && rightValue instanceof Date) {
      return (leftValue.getTime() - rightValue.getTime()) * factor;
    }

    if (typeof leftValue === "bigint" && typeof rightValue === "bigint") {
      return leftValue === rightValue
        ? 0
        : leftValue > rightValue
          ? factor
          : -factor;
    }

    if (leftValue === rightValue) {
      return 0;
    }

    return leftValue > rightValue ? factor : -factor;
  });
}

function applyPagination<T>(rows: T[], skip?: number, take?: number): T[] {
  const skipped = rows.slice(skip ?? 0);
  return typeof take === "number" ? skipped.slice(0, take) : skipped;
}

function createEmptyState(): CompatibilityState {
  return {
    tokens: [],
    burnRecords: [],
    analytics: [],
    users: [],
    campaigns: [],
    campaignExecutions: [],
    proposals: [],
    votes: [],
    proposalExecutions: [],
    streams: [],
    sequence: 1,
  };
}

function nextId(state: CompatibilityState, prefix: string): string {
  const id = `${prefix}-${state.sequence}`;
  state.sequence += 1;
  return id;
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined || row === null) {
    throw new Error(message);
  }

  return row;
}

function seedLegacyProjectionState(state: CompatibilityState) {
  state.tokens.push(cloneValue(compatibilitySeedData.legacy.token));
  state.burnRecords.push(cloneValue(compatibilitySeedData.legacy.burnRecord));
  state.analytics.push(cloneValue(compatibilitySeedData.legacy.analytics));
  state.campaigns.push(cloneValue(compatibilitySeedData.legacy.campaign));
  state.campaignExecutions.push(
    cloneValue(compatibilitySeedData.legacy.campaignExecution)
  );
  state.proposals.push(cloneValue(compatibilitySeedData.legacy.proposal));
  for (const proposal of compatibilitySeedData.legacy.lifecycleProposals) {
    state.proposals.push(cloneValue(proposal));
  }
  state.proposalExecutions.push(
    cloneValue(compatibilitySeedData.legacy.lifecycleProposalExecution)
  );
  state.votes.push(cloneValue(compatibilitySeedData.legacy.vote));
  state.streams.push(cloneValue(compatibilitySeedData.legacy.stream));
}

export function createCompatibilityHarness(
  seedMode: CompatibilitySeedMode = "empty"
) {
  const state = createEmptyState();

  if (seedMode === "legacy-populated") {
    seedLegacyProjectionState(state);
  }

  const prisma = {
    token: {
      create: async ({ data }: { data: Partial<TokenRow> }) => {
        const row: TokenRow = {
          id: data.id ?? nextId(state, "token"),
          address: requireRow(data.address, "token.address is required"),
          creator: requireRow(data.creator, "token.creator is required"),
          name: requireRow(data.name, "token.name is required"),
          symbol: requireRow(data.symbol, "token.symbol is required"),
          decimals: data.decimals ?? 18,
          totalSupply: BigInt(
            requireRow(
              data.totalSupply,
              "token.totalSupply is required"
            ).toString()
          ),
          initialSupply: BigInt(
            requireRow(
              data.initialSupply,
              "token.initialSupply is required"
            ).toString()
          ),
          totalBurned: BigInt((data.totalBurned ?? BigInt(0)).toString()),
          burnCount: data.burnCount ?? 0,
          metadataUri: data.metadataUri ?? null,
          createdAt: cloneValue(data.createdAt ?? baseDates.seededAt),
          updatedAt: cloneValue(
            data.updatedAt ?? data.createdAt ?? baseDates.seededAt
          ),
        };

        state.tokens.push(row);
        return cloneValue(row);
      },
      createMany: async ({ data }: { data: Partial<TokenRow>[] }) => {
        for (const entry of data) {
          await prisma.token.create({ data: entry });
        }
        return { count: data.length };
      },
      findUnique: async ({
        where,
        include,
      }: {
        where: { id?: string; address?: string };
        include?: Record<string, boolean>;
      }) => {
        const row = state.tokens.find(
          (token) =>
            (where.id && token.id === where.id) ||
            (where.address && token.address === where.address)
        );

        if (!row) {
          return null;
        }

        const cloned = cloneValue(row) as Record<string, any>;
        if (include?.burnRecords) {
          cloned.burnRecords = state.burnRecords
            .filter((burn) => burn.tokenId === row.id)
            .map((burn) => cloneValue(burn));
        }
        if (include?.analytics) {
          cloned.analytics = state.analytics
            .filter((analytics) => analytics.tokenId === row.id)
            .map((analytics) => cloneValue(analytics));
        }
        return cloned;
      },
      findMany: async ({
        where,
        orderBy,
        skip,
        take,
      }: {
        where?: Record<string, any>;
        orderBy?: Record<string, "asc" | "desc">;
        skip?: number;
        take?: number;
      } = {}) => {
        const filtered = state.tokens.filter((row) => matchesWhere(row, where));
        return applyPagination(sortRows(filtered, orderBy), skip, take).map(
          (row) => cloneValue(row)
        );
      },
      update: async ({
        where,
        data,
      }: {
        where: { id?: string; address?: string };
        data: Record<string, any>;
      }) => {
        const row = requireRow(
          state.tokens.find(
            (token) =>
              (where.id && token.id === where.id) ||
              (where.address && token.address === where.address)
          ),
          "Token not found"
        );

        if (data.totalBurned?.increment !== undefined) {
          row.totalBurned += BigInt(data.totalBurned.increment.toString());
        } else if (data.totalBurned !== undefined) {
          row.totalBurned = BigInt(data.totalBurned.toString());
        }

        if (data.burnCount?.increment !== undefined) {
          row.burnCount += Number(data.burnCount.increment);
        } else if (data.burnCount !== undefined) {
          row.burnCount = Number(data.burnCount);
        }

        if (data.metadataUri !== undefined) {
          row.metadataUri = data.metadataUri;
        }

        if (data.updatedAt) {
          row.updatedAt = cloneValue(data.updatedAt);
        }

        return cloneValue(row);
      },
      updateMany: async ({ data }: { data: Record<string, any> }) => {
        for (const row of state.tokens) {
          if (data.totalBurned !== undefined) {
            row.totalBurned = BigInt(data.totalBurned.toString());
          }
          if (data.burnCount !== undefined) {
            row.burnCount = Number(data.burnCount);
          }
        }
        return { count: state.tokens.length };
      },
      count: async ({ where }: { where?: Record<string, any> } = {}) =>
        state.tokens.filter((row) => matchesWhere(row, where)).length,
      deleteMany: async () => {
        state.tokens = [];
        return { count: 0 };
      },
    },
    burnRecord: {
      create: async ({ data }: { data: Partial<BurnRecordRow> }) => {
        const row: BurnRecordRow = {
          id: data.id ?? nextId(state, "burn"),
          tokenId: requireRow(data.tokenId, "burnRecord.tokenId is required"),
          from: requireRow(data.from, "burnRecord.from is required"),
          amount: BigInt(
            requireRow(data.amount, "burnRecord.amount is required").toString()
          ),
          burnedBy: requireRow(
            data.burnedBy,
            "burnRecord.burnedBy is required"
          ),
          isAdminBurn: data.isAdminBurn ?? false,
          txHash: requireRow(data.txHash, "burnRecord.txHash is required"),
          timestamp: cloneValue(data.timestamp ?? baseDates.seededAt),
        };
        state.burnRecords.push(row);
        return cloneValue(row);
      },
      findUnique: async ({ where }: { where: { txHash: string } }) => {
        const row = state.burnRecords.find(
          (burn) => burn.txHash === where.txHash
        );
        return row ? cloneValue(row) : null;
      },
      findMany: async ({
        where,
        orderBy,
        skip,
        take,
      }: {
        where?: Record<string, any>;
        orderBy?: Record<string, "asc" | "desc">;
        skip?: number;
        take?: number;
      } = {}) => {
        const filtered = state.burnRecords.filter((row) =>
          matchesWhere(row, where)
        );
        return applyPagination(sortRows(filtered, orderBy), skip, take).map(
          (row) => cloneValue(row)
        );
      },
      deleteMany: async () => {
        state.burnRecords = [];
        return { count: 0 };
      },
    },
    analytics: {
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { tokenId_date: { tokenId: string; date: Date } };
        update: Record<string, any>;
        create: Partial<AnalyticsRow>;
      }) => {
        const normalizedDate = normalizeDate(where.tokenId_date.date);
        const existing = state.analytics.find(
          (row) =>
            row.tokenId === where.tokenId_date.tokenId &&
            row.date.getTime() === normalizedDate.getTime()
        );

        if (existing) {
          if (update.burnVolume?.increment !== undefined) {
            existing.burnVolume += BigInt(
              update.burnVolume.increment.toString()
            );
          }
          if (update.burnCount?.increment !== undefined) {
            existing.burnCount += Number(update.burnCount.increment);
          }
          if (update.uniqueBurners !== undefined) {
            existing.uniqueBurners = Number(update.uniqueBurners);
          }
          existing.updatedAt = baseDates.seededAt;
          return cloneValue(existing);
        }

        const row: AnalyticsRow = {
          id: create.id ?? nextId(state, "analytics"),
          tokenId: requireRow(create.tokenId, "analytics.tokenId is required"),
          date: normalizeDate(
            requireRow(create.date, "analytics.date is required")
          ),
          burnVolume: BigInt(
            requireRow(
              create.burnVolume,
              "analytics.burnVolume is required"
            ).toString()
          ),
          burnCount: create.burnCount ?? 0,
          uniqueBurners: create.uniqueBurners ?? 0,
          createdAt: cloneValue(create.createdAt ?? baseDates.seededAt),
          updatedAt: cloneValue(create.updatedAt ?? baseDates.seededAt),
        };
        state.analytics.push(row);
        return cloneValue(row);
      },
      findMany: async ({ where }: { where?: Record<string, any> } = {}) =>
        state.analytics
          .filter((row) => matchesWhere(row, where))
          .map((row) => cloneValue(row)),
      deleteMany: async () => {
        state.analytics = [];
        return { count: 0 };
      },
    },
    user: {
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { address: string };
        update: Partial<UserRow>;
        create: Partial<UserRow>;
      }) => {
        const existing = state.users.find(
          (user) => user.address === where.address
        );
        if (existing) {
          existing.lastActive = cloneValue(
            update.lastActive ?? baseDates.seededAt
          );
          return cloneValue(existing);
        }

        const row: UserRow = {
          id: create.id ?? nextId(state, "user"),
          address: requireRow(create.address, "user.address is required"),
          createdAt: cloneValue(create.createdAt ?? baseDates.seededAt),
          lastActive: cloneValue(create.lastActive ?? baseDates.seededAt),
        };
        state.users.push(row);
        return cloneValue(row);
      },
    },
    campaign: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { campaignId: number };
        create: Partial<CampaignRow>;
        update: Partial<CampaignRow>;
      }) => {
        const existing = state.campaigns.find(
          (campaign) => campaign.campaignId === where.campaignId
        );
        if (existing) {
          Object.assign(existing, cloneValue(update));
          return cloneValue(existing);
        }

        const row: CampaignRow = {
          id: create.id ?? nextId(state, "campaign"),
          campaignId: requireRow(
            create.campaignId,
            "campaign.campaignId is required"
          ),
          tokenId: requireRow(create.tokenId, "campaign.tokenId is required"),
          creator: requireRow(create.creator, "campaign.creator is required"),
          type: requireRow(create.type, "campaign.type is required"),
          status: (create.status ?? "ACTIVE") as CampaignRow["status"],
          targetAmount: BigInt(
            requireRow(
              create.targetAmount,
              "campaign.targetAmount is required"
            ).toString()
          ),
          currentAmount: BigInt((create.currentAmount ?? BigInt(0)).toString()),
          executionCount: create.executionCount ?? 0,
          startTime: cloneValue(
            requireRow(create.startTime, "campaign.startTime is required")
          ),
          endTime: cloneValue(create.endTime ?? null),
          metadata: create.metadata ?? null,
          txHash: requireRow(create.txHash, "campaign.txHash is required"),
          createdAt: cloneValue(
            create.createdAt ?? create.startTime ?? baseDates.seededAt
          ),
          updatedAt: cloneValue(
            create.updatedAt ?? create.startTime ?? baseDates.seededAt
          ),
          completedAt: cloneValue(create.completedAt ?? null),
          cancelledAt: cloneValue(create.cancelledAt ?? null),
        };
        state.campaigns.push(row);
        return cloneValue(row);
      },
      findUnique: async ({
        where,
        include,
      }: {
        where: { id?: string; campaignId?: number };
        include?: Record<string, any>;
      }) => {
        const row = state.campaigns.find(
          (campaign) =>
            (where.id && campaign.id === where.id) ||
            (where.campaignId && campaign.campaignId === where.campaignId)
        );

        if (!row) {
          return null;
        }

        const cloned = cloneValue(row) as Record<string, any>;
        if (include?.executions) {
          const executions = state.campaignExecutions.filter(
            (execution) => execution.campaignId === row.id
          );
          cloned.executions = applyPagination(
            sortRows(executions, include.executions.orderBy),
            0,
            include.executions.take
          ).map((execution) => cloneValue(execution));
        }
        return cloned;
      },
      findMany: async ({
        where,
        orderBy,
      }: {
        where?: Record<string, any>;
        orderBy?: Record<string, "asc" | "desc">;
      } = {}) => {
        const filtered = state.campaigns.filter((row) =>
          matchesWhere(row, where)
        );
        return sortRows(filtered, orderBy).map((row) => cloneValue(row));
      },
      count: async ({ where }: { where?: Record<string, any> } = {}) =>
        state.campaigns.filter((row) => matchesWhere(row, where)).length,
      aggregate: async ({ where }: { where?: Record<string, any> }) => {
        const filtered = state.campaigns.filter((row) =>
          matchesWhere(row, where)
        );
        return {
          _sum: {
            currentAmount: filtered.reduce(
              (sum, row) => sum + row.currentAmount,
              BigInt(0)
            ),
            executionCount: filtered.reduce(
              (sum, row) => sum + row.executionCount,
              0
            ),
          },
        };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id?: string; campaignId?: number };
        data: Record<string, any>;
      }) => {
        const row = requireRow(
          state.campaigns.find(
            (campaign) =>
              (where.id && campaign.id === where.id) ||
              (where.campaignId && campaign.campaignId === where.campaignId)
          ),
          "Campaign not found"
        );

        if (data.currentAmount?.increment !== undefined) {
          row.currentAmount += BigInt(data.currentAmount.increment.toString());
        } else if (data.currentAmount !== undefined) {
          row.currentAmount = BigInt(data.currentAmount.toString());
        }

        if (data.executionCount?.increment !== undefined) {
          row.executionCount += Number(data.executionCount.increment);
        } else if (data.executionCount !== undefined) {
          row.executionCount = Number(data.executionCount);
        }

        if (data.status !== undefined) {
          row.status = data.status;
        }
        if (data.updatedAt !== undefined) {
          row.updatedAt = cloneValue(data.updatedAt);
        }
        if (data.completedAt !== undefined) {
          row.completedAt = cloneValue(data.completedAt);
        }
        if (data.cancelledAt !== undefined) {
          row.cancelledAt = cloneValue(data.cancelledAt);
        }

        return cloneValue(row);
      },
      deleteMany: async () => {
        state.campaigns = [];
        return { count: 0 };
      },
    },
    campaignExecution: {
      create: async ({ data }: { data: Partial<CampaignExecutionRow> }) => {
        const row: CampaignExecutionRow = {
          id: data.id ?? nextId(state, "campaign-execution"),
          campaignId: requireRow(
            data.campaignId,
            "campaignExecution.campaignId is required"
          ),
          executor: requireRow(
            data.executor,
            "campaignExecution.executor is required"
          ),
          amount: BigInt(
            requireRow(
              data.amount,
              "campaignExecution.amount is required"
            ).toString()
          ),
          recipient: data.recipient ?? null,
          txHash: requireRow(
            data.txHash,
            "campaignExecution.txHash is required"
          ),
          executedAt: cloneValue(data.executedAt ?? baseDates.seededAt),
        };
        state.campaignExecutions.push(row);
        return cloneValue(row);
      },
      findUnique: async ({ where }: { where: { txHash: string } }) => {
        const row = state.campaignExecutions.find(
          (execution) => execution.txHash === where.txHash
        );
        return row ? cloneValue(row) : null;
      },
      findMany: async ({
        where,
        orderBy,
        take,
        skip,
      }: {
        where?: Record<string, any>;
        orderBy?: Record<string, "asc" | "desc">;
        take?: number;
        skip?: number;
      } = {}) => {
        const filtered = state.campaignExecutions.filter((row) =>
          matchesWhere(row, where)
        );
        return applyPagination(sortRows(filtered, orderBy), skip, take).map(
          (row) => cloneValue(row)
        );
      },
      count: async ({ where }: { where?: Record<string, any> } = {}) =>
        state.campaignExecutions.filter((row) => matchesWhere(row, where))
          .length,
      deleteMany: async () => {
        state.campaignExecutions = [];
        return { count: 0 };
      },
    },
    proposal: {
      create: async ({ data }: { data: Partial<ProposalRow> }) => {
        const row: ProposalRow = {
          id: data.id ?? nextId(state, "proposal"),
          proposalId: requireRow(
            data.proposalId,
            "proposal.proposalId is required"
          ),
          tokenId: requireRow(data.tokenId, "proposal.tokenId is required"),
          proposer: requireRow(data.proposer, "proposal.proposer is required"),
          title: requireRow(data.title, "proposal.title is required"),
          description: data.description ?? null,
          proposalType: requireRow(
            data.proposalType,
            "proposal.proposalType is required"
          ),
          status: data.status ?? compatibilityEnums.ProposalStatus.ACTIVE,
          startTime: cloneValue(
            requireRow(data.startTime, "proposal.startTime is required")
          ),
          endTime: cloneValue(
            requireRow(data.endTime, "proposal.endTime is required")
          ),
          quorum: BigInt(
            requireRow(data.quorum, "proposal.quorum is required").toString()
          ),
          threshold: BigInt(
            requireRow(
              data.threshold,
              "proposal.threshold is required"
            ).toString()
          ),
          metadata: data.metadata ?? null,
          txHash: requireRow(data.txHash, "proposal.txHash is required"),
          createdAt: cloneValue(
            data.createdAt ?? data.startTime ?? baseDates.seededAt
          ),
          updatedAt: cloneValue(
            data.updatedAt ?? data.startTime ?? baseDates.seededAt
          ),
          executedAt: cloneValue(data.executedAt ?? null),
          cancelledAt: cloneValue(data.cancelledAt ?? null),
        };
        state.proposals.push(row);
        return cloneValue(row);
      },
      findUnique: async ({
        where,
        include,
      }: {
        where: { id?: string; proposalId?: number };
        include?: Record<string, boolean>;
      }) => {
        const row = state.proposals.find(
          (proposal) =>
            (where.id && proposal.id === where.id) ||
            (where.proposalId && proposal.proposalId === where.proposalId)
        );

        if (!row) {
          return null;
        }

        const cloned = cloneValue(row) as Record<string, any>;
        if (include?.votes) {
          cloned.votes = state.votes
            .filter((vote) => vote.proposalId === row.id)
            .map((vote) => cloneValue(vote));
        }
        if (include?.executions) {
          cloned.executions = state.proposalExecutions
            .filter((execution) => execution.proposalId === row.id)
            .map((execution) => cloneValue(execution));
        }
        return cloned;
      },
      findMany: async ({
        where,
      }: {
        where?: { status?: string };
      } = {}) =>
        state.proposals
          .filter(
            (proposal) =>
              where?.status === undefined || proposal.status === where.status
          )
          .map((proposal) => cloneValue(proposal)),
      update: async ({
        where,
        data,
      }: {
        where: { id?: string; proposalId?: number };
        data: Record<string, any>;
      }) => {
        const row = requireRow(
          state.proposals.find(
            (proposal) =>
              (where.id && proposal.id === where.id) ||
              (where.proposalId && proposal.proposalId === where.proposalId)
          ),
          "Proposal not found"
        );

        if (data.status !== undefined) {
          row.status = data.status;
        }
        if (data.executedAt !== undefined) {
          row.executedAt = cloneValue(data.executedAt);
        }
        if (data.cancelledAt !== undefined) {
          row.cancelledAt = cloneValue(data.cancelledAt);
        }
        if (data.description !== undefined) {
          row.description = data.description;
        }
        if (data.metadata !== undefined) {
          row.metadata = data.metadata;
        }
        if (data.updatedAt !== undefined) {
          row.updatedAt = cloneValue(data.updatedAt);
        }

        return cloneValue(row);
      },
      deleteMany: async () => {
        state.proposals = [];
        return { count: 0 };
      },
    },
    vote: {
      create: async ({ data }: { data: Partial<VoteRow> }) => {
        const row: VoteRow = {
          id: data.id ?? nextId(state, "vote"),
          proposalId: requireRow(
            data.proposalId,
            "vote.proposalId is required"
          ),
          voter: requireRow(data.voter, "vote.voter is required"),
          support: Boolean(
            requireRow(data.support, "vote.support is required")
          ),
          weight: BigInt(
            requireRow(data.weight, "vote.weight is required").toString()
          ),
          reason: data.reason ?? null,
          txHash: requireRow(data.txHash, "vote.txHash is required"),
          timestamp: cloneValue(data.timestamp ?? baseDates.seededAt),
        };
        state.votes.push(row);
        return cloneValue(row);
      },
      findUnique: async ({ where }: { where: { txHash: string } }) => {
        const row = state.votes.find((vote) => vote.txHash === where.txHash);
        return row ? cloneValue(row) : null;
      },
      deleteMany: async () => {
        state.votes = [];
        return { count: 0 };
      },
    },
    proposalExecution: {
      create: async ({ data }: { data: Partial<ProposalExecutionRow> }) => {
        const row: ProposalExecutionRow = {
          id: data.id ?? nextId(state, "proposal-execution"),
          proposalId: requireRow(
            data.proposalId,
            "proposalExecution.proposalId is required"
          ),
          executor: requireRow(
            data.executor,
            "proposalExecution.executor is required"
          ),
          success: Boolean(
            requireRow(data.success, "proposalExecution.success is required")
          ),
          returnData: data.returnData ?? null,
          gasUsed:
            data.gasUsed !== undefined && data.gasUsed !== null
              ? BigInt(data.gasUsed.toString())
              : null,
          txHash: requireRow(
            data.txHash,
            "proposalExecution.txHash is required"
          ),
          executedAt: cloneValue(data.executedAt ?? baseDates.seededAt),
        };
        state.proposalExecutions.push(row);
        return cloneValue(row);
      },
      deleteMany: async () => {
        state.proposalExecutions = [];
        return { count: 0 };
      },
    },
    stream: {
      create: async ({ data }: { data: Partial<StreamRow> }) => {
        const row: StreamRow = {
          id: data.id ?? nextId(state, "stream"),
          streamId: requireRow(data.streamId, "stream.streamId is required"),
          creator: requireRow(data.creator, "stream.creator is required"),
          recipient: requireRow(data.recipient, "stream.recipient is required"),
          amount: BigInt(
            requireRow(data.amount, "stream.amount is required").toString()
          ),
          metadata: data.metadata ?? null,
          status: data.status ?? compatibilityEnums.StreamStatus.CREATED,
          txHash: requireRow(data.txHash, "stream.txHash is required"),
          createdAt: cloneValue(data.createdAt ?? baseDates.seededAt),
          claimedAt: cloneValue(data.claimedAt ?? null),
          cancelledAt: cloneValue(data.cancelledAt ?? null),
        };
        state.streams.push(row);
        return cloneValue(row);
      },
      findUnique: async ({ where }: { where: { streamId: number } }) => {
        const row = state.streams.find(
          (stream) => stream.streamId === where.streamId
        );
        return row ? cloneValue(row) : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { streamId: number };
        data: Record<string, any>;
      }) => {
        const row = requireRow(
          state.streams.find((stream) => stream.streamId === where.streamId),
          "Stream not found"
        );
        if (data.status !== undefined) {
          row.status = data.status;
        }
        if (data.claimedAt !== undefined) {
          row.claimedAt = cloneValue(data.claimedAt);
        }
        if (data.cancelledAt !== undefined) {
          row.cancelledAt = cloneValue(data.cancelledAt);
        }
        if (data.metadata !== undefined) {
          row.metadata = data.metadata;
        }
        return cloneValue(row);
      },
      deleteMany: async () => {
        state.streams = [];
        return { count: 0 };
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    $connect: async () => undefined,
    $disconnect: async () => undefined,
  };

  return {
    state,
    prisma,
    compatibilitySeedData,
  };
}
