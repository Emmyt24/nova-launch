import { describe, it, expect, vi, beforeEach } from 'vitest';

const deployTokenMock = vi.fn();

vi.mock('../../services/stellar-service-integration', () => ({
  stellarServiceIntegration: {
    deployToken: deployTokenMock,
  },
}));

import { batchTokenDeployService } from '../batchTokenDeployService';

describe('batchTokenDeployService', () => {
  beforeEach(() => {
    deployTokenMock.mockReset();
  });

  it('invokes the real factory contract deploy path instead of synthesizing an address', async () => {
    deployTokenMock.mockResolvedValue({
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      transactionHash: 'abc123',
    });

    const result = await batchTokenDeployService.deployToken({
      name: 'Test Token',
      symbol: 'TST',
      decimals: 7,
      supply: '1000000',
      admin: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    });

    expect(deployTokenMock).toHaveBeenCalledTimes(1);
    expect(deployTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test Token',
        symbol: 'TST',
        decimals: 7,
        supply: '1000000',
        admin: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      }),
    );
    expect(result.contractId).toBe(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    );
  });

  it('propagates errors from the real deploy path so retry handling can act', async () => {
    deployTokenMock.mockRejectedValue(new Error('factory contract call failed'));

    await expect(
      batchTokenDeployService.deployToken({
        name: 'Test Token',
        symbol: 'TST',
        decimals: 7,
        supply: '1000000',
        admin: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      }),
    ).rejects.toThrow('factory contract call failed');

    expect(deployTokenMock).toHaveBeenCalledTimes(1);
  });
});
