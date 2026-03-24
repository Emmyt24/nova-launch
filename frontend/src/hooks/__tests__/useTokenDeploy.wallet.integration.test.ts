/**
 * Wallet-signed deployment integration tests for useTokenDeploy
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockDeployToken = vi.fn();
const mockAddToken = vi.fn();

vi.mock('../../services/stellar.service', () => ({
  StellarService: vi.fn().mockImplementation(function(this: any) {
    this.deployToken = mockDeployToken;
  }),
}));

vi.mock('../../services/TransactionHistoryStorage', () => ({
  TransactionHistoryStorage: {
    getInstance: () => ({ addToken: mockAddToken }),
  },
}));

vi.mock('../../services/IPFSService', () => ({
  IPFSService: vi.fn().mockImplementation(function(this: any) {
    this.uploadMetadata = vi.fn();
  }),
}));

vi.mock('../../services/analytics', () => ({
  analytics: { track: vi.fn() },
  AnalyticsEvent: { TOKEN_DEPLOYED: 'token_deployed', TOKEN_DEPLOY_FAILED: 'token_deploy_failed' },
}));

vi.mock('../../hooks/useAnalytics', () => ({
  useAnalytics: () => ({ trackTokenDeployed: vi.fn(), trackTokenDeployFailed: vi.fn() }),
}));

import { useTokenDeploy } from '../useTokenDeploy';

const WALLET = 'GCREATOR4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';
const validParams = {
  name: 'TestToken', symbol: 'TTK', decimals: 7,
  initialSupply: '1000000', adminWallet: WALLET,
};
const serviceResult = { tokenAddress: 'CTOKEN', transactionHash: 'txhash123', creatorBalance: '1000000' };

describe('useTokenDeploy — wallet-signed flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeployToken.mockResolvedValue(serviceResult);
  });

  it('rejects deploy when adminWallet is missing', async () => {
    const { result } = renderHook(() => useTokenDeploy('testnet'));
    let thrown: any;
    await act(async () => {
      try { await result.current.deploy({ ...validParams, adminWallet: '' }); }
      catch (e) { thrown = e; }
    });
    expect(thrown).toMatchObject({ code: 'WALLET_NOT_CONNECTED' });
    expect(result.current.status).toBe('error');
    expect(mockDeployToken).not.toHaveBeenCalled();
  });

  it('maps wallet rejection to WALLET_REJECTED error', async () => {
    mockDeployToken.mockRejectedValueOnce(new Error('User rejected signing'));
    const { result } = renderHook(() => useTokenDeploy('testnet'));
    let thrown: any;
    await act(async () => {
      try { await result.current.deploy(validParams); }
      catch (e) { thrown = e; }
    });
    expect(thrown).toMatchObject({ code: 'WALLET_REJECTED' });
    expect(result.current.status).toBe('error');
  });

  it('persists deployment to TransactionHistoryStorage on success', async () => {
    const { result } = renderHook(() => useTokenDeploy('testnet'));
    await act(async () => { await result.current.deploy(validParams); });
    expect(mockAddToken).toHaveBeenCalledWith(
      WALLET,
      expect.objectContaining({ address: 'CTOKEN', transactionHash: 'txhash123', creator: WALLET })
    );
  });

  it('returns DeploymentResult with correct shape', async () => {
    const { result } = renderHook(() => useTokenDeploy('testnet'));
    let deployment: any;
    await act(async () => { deployment = await result.current.deploy(validParams); });
    expect(deployment.tokenAddress).toBe('CTOKEN');
    expect(deployment.transactionHash).toBe('txhash123');
    expect(typeof deployment.timestamp).toBe('number');
    expect(typeof deployment.totalFee).toBe('string');
  });

  it('retry reuses lastParams without regenerating stale values', async () => {
    mockDeployToken.mockRejectedValueOnce(new Error('network error'));
    mockDeployToken.mockResolvedValueOnce(serviceResult);
    const { result } = renderHook(() => useTokenDeploy('testnet', { retryDelay: 0 }));
    await act(async () => {
      try { await result.current.deploy(validParams); } catch {}
    });
    await act(async () => { await result.current.retry(); });
    expect(mockDeployToken).toHaveBeenCalledTimes(2);
    const [first, second] = mockDeployToken.mock.calls;
    expect(first[0].name).toBe(second[0].name);
    expect(first[0].creatorAddress).toBe(second[0].creatorAddress);
  });

  it('storage failure does not fail the deployment', async () => {
    mockAddToken.mockImplementationOnce(() => { throw new Error('quota exceeded'); });
    const { result } = renderHook(() => useTokenDeploy('testnet'));
    await act(async () => { await result.current.deploy(validParams); });
    expect(result.current.status).toBe('success');
  });
});
