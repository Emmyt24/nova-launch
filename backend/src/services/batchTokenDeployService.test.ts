import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Stellar deploy helper before importing the service under test.
vi.mock('./stellarDeployService', () => ({
  callStellarDeploy: vi.fn(),
}));

// Mock the event emitter used by the service.
vi.mock('./eventEmitter', () => ({
  emitEvent: vi.fn(),
}));

// Mock Prisma client.
vi.mock('../lib/prisma', () => {
  const txMock = {
    tokenDeployment: {
      create: vi.fn(),
      update: vi.fn(),
    },
    batchDeployment: {
      update: vi.fn(),
    },
  };

  const prismaMock = {
    batchDeployment: {
      create: vi.fn(),
      update: vi.fn(),
    },
    tokenDeployment: {
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: typeof txMock) => unknown) => cb(txMock)),
    __txMock: txMock,
  };

  return { prisma: prismaMock, default: prismaMock };
});

import { callStellarDeploy } from './stellarDeployService';
import { emitEvent } from './eventEmitter';
import { prisma } from '../lib/prisma';
import { batchDeployTokens } from './batchTokenDeployService';

const mockedCallStellarDeploy = vi.mocked(callStellarDeploy);
const mockedEmitEvent = vi.mocked(emitEvent);
const mockedPrisma = prisma as unknown as {
  batchDeployment: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  tokenDeployment: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  __txMock: {
    tokenDeployment: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    batchDeployment: { update: ReturnType<typeof vi.fn> };
  };
};

const baseToken = {
  name: 'Test Token',
  symbol: 'TST',
  decimals: 7,
  totalSupply: '1000000',
  ownerPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
};

describe('batchDeployTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.batchDeployment.create.mockResolvedValue({
      id: 'batch-1',
      status: 'PENDING',
    });

    mockedPrisma.__txMock.tokenDeployment.create.mockImplementation(async (args: any) => ({
      id: 'token-1',
      ...args.data,
    }));

    mockedPrisma.__txMock.tokenDeployment.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      ...args.data,
    }));

    mockedPrisma.__txMock.batchDeployment.update.mockResolvedValue({
      id: 'batch-1',
      status: 'COMPLETED',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the on-chain tx hash from the submission response', async () => {
    const expectedTxHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

    mockedCallStellarDeploy.mockResolvedValue({
      txHash: expectedTxHash,
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    } as any);

    await batchDeployTokens({ tokens: [baseToken] } as any);

    // The token.deployed event must carry the authoritative on-chain hash.
    const deployedEvent = mockedEmitEvent.mock.calls.find(
      ([eventName]) => eventName === 'token.deployed',
    );
    expect(deployedEvent).toBeDefined();
    const payload = deployedEvent![1] as { txHash: string | null };
    expect(payload.txHash).toBe(expectedTxHash);

    // The hash must also be persisted on the batch result record.
    const updateCalls = mockedPrisma.__txMock.tokenDeployment.update.mock.calls;
    const persistedTxHash = updateCalls
      .map(([args]) => (args as any).data?.txHash)
      .find((value) => value !== undefined);
    expect(persistedTxHash).toBe(expectedTxHash);
  });

  it('falls back to null when the submission response has no tx hash', async () => {
    mockedCallStellarDeploy.mockResolvedValue({
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    } as any);

    await batchDeployTokens({ tokens: [baseToken] } as any);

    const deployedEvent = mockedEmitEvent.mock.calls.find(
      ([eventName]) => eventName === 'token.deployed',
    );
    expect(deployedEvent).toBeDefined();
    const payload = deployedEvent![1] as { txHash: string | null };
    expect(payload.txHash).toBeNull();

    const updateCalls = mockedPrisma.__txMock.tokenDeployment.update.mock.calls;
    const persistedTxHash = updateCalls
      .map(([args]) => (args as any).data?.txHash)
      .find((value) => value !== undefined);
    expect(persistedTxHash).toBeNull();
  });
});