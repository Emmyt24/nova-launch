/**
 * Issue #1081 — Model the useTokenDeploy hook as a state machine and lock down its transitions
 *
 * Asserts each transition:
 *   idle → deploying → success
 *   idle → uploading → deploying → success (with metadata)
 *   idle → error (validation failure)
 *   idle → deploying → error (network failure)
 *   error → idle (recovery via reset)
 *   error → deploying → success (recovery via retry)
 *
 * Also asserts the hook does not fire duplicate submissions.
 *
 * Fixtures:
 *   VALID_ADDR — a valid Stellar address (G + 55 chars from [A-Z2-7])
 *   DEPLOY_RESULT — a minimal successful deployment result
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTokenDeploy } from '../useTokenDeploy';
import { IPFSService } from '../../services/IPFSService';
import { StellarService } from '../../services/stellar.service';
import { analytics } from '../../services/analytics';
import { ErrorCode } from '../../types';
import type { WalletState } from '../../types';

vi.mock('../../services/IPFSService');
vi.mock('../../services/stellar.service');
vi.mock('../../services/analytics');

// Keep the real isValidIpfsUri so the hook's URI validation passes
import * as IPFSModule from '../../services/IPFSService';
vi.spyOn(IPFSModule, 'isValidIpfsUri').mockReturnValue(true);
vi.mock('../../services/stellar.service');
vi.mock('../../services/analytics');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Valid Stellar address: G + 55 chars from [A-Z2-7] = 56 chars total */
const VALID_ADDR = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

const WALLET: WalletState = {
  connected: true,
  address: VALID_ADDR,
  network: 'testnet',
};

const VALID_PARAMS = {
  name: 'State Machine Token',
  symbol: 'SMT',
  decimals: 7,
  initialSupply: '1000000',
  adminWallet: VALID_ADDR,
};

const DEPLOY_RESULT = {
  tokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  transactionHash: 'sm-tx-hash',
  timestamp: Date.now(),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(analytics.track).mockImplementation(() => {});
  // Default: contract is not paused
  vi.mocked(StellarService.prototype.isPaused).mockResolvedValue(false);
});

// ── State machine tests ───────────────────────────────────────────────────────

describe('useTokenDeploy state machine (#1081)', () => {
  describe('1. Initial state — idle', () => {
    it('starts in idle state with no error and isDeploying=false', () => {
      const { result } = renderHook(() => useTokenDeploy(WALLET));

      expect(result.current.status).toBe('idle');
      expect(result.current.error).toBeNull();
      expect(result.current.isDeploying).toBe(false);
      expect(result.current.statusMessage).toBe('');
      expect(result.current.canRetry).toBe(false);
    });
  });

  describe('2. idle → deploying → success', () => {
    it('transitions through deploying to success on a successful deploy', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(DEPLOY_RESULT), 50))
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      act(() => { result.current.deploy(VALID_PARAMS); });

      await waitFor(() => expect(result.current.status).toBe('deploying'));
      expect(result.current.isDeploying).toBe(true);

      await waitFor(() => expect(result.current.status).toBe('success'));
      expect(result.current.error).toBeNull();
      expect(result.current.isDeploying).toBe(false);
    });

    it('returns the deployment result on success', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockResolvedValue(DEPLOY_RESULT);

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      let deployResult: any;
      await act(async () => {
        deployResult = await result.current.deploy(VALID_PARAMS);
      });

      expect(deployResult.tokenAddress).toBe(DEPLOY_RESULT.tokenAddress);
      expect(deployResult.transactionHash).toBe(DEPLOY_RESULT.transactionHash);
      expect(result.current.status).toBe('success');
    });
  });

  describe('3. idle → uploading → deploying → success (with metadata)', () => {
    it('transitions through uploading then deploying when metadata is provided', async () => {
      const VALID_IPFS_URI = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      vi.mocked(IPFSService.prototype.uploadMetadata).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(VALID_IPFS_URI), 50))
      );
      vi.mocked(StellarService.prototype.deployToken).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(DEPLOY_RESULT), 50))
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      const mockImage = new File(['img'], 'logo.png', { type: 'image/png' });
      const params = { ...VALID_PARAMS, metadata: { image: mockImage, description: 'A token' } };

      act(() => { result.current.deploy(params); });

      await waitFor(() => expect(result.current.status).toBe('uploading'));
      await waitFor(() => expect(result.current.status).toBe('deploying'));
      await waitFor(() => expect(result.current.status).toBe('success'));

      expect(result.current.error).toBeNull();
    });
  });

  describe('4. idle → error (validation failure)', () => {
    it('transitions to error on invalid params without entering deploying', async () => {
      const { result } = renderHook(() => useTokenDeploy(WALLET));

      await act(async () => {
        await expect(
          result.current.deploy({ ...VALID_PARAMS, name: '' })
        ).rejects.toThrow();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error?.code).toBe(ErrorCode.INVALID_INPUT);
      expect(result.current.isDeploying).toBe(false);
      // StellarService must never be called for a validation error
      expect(StellarService.prototype.deployToken).not.toHaveBeenCalled();
    });

    it('transitions to error when wallet address is missing (empty string)', async () => {
      const { result } = renderHook(() => useTokenDeploy(WALLET));

      let thrownError: any;
      await act(async () => {
        try {
          await result.current.deploy({ ...VALID_PARAMS, adminWallet: '' });
        } catch (e) {
          thrownError = e;
        }
      });

      // The hook throws with WALLET_NOT_CONNECTED code
      expect(thrownError?.code).toBe(ErrorCode.WALLET_NOT_CONNECTED);
      // StellarService is never called for a missing wallet
      expect(StellarService.prototype.deployToken).not.toHaveBeenCalled();
    });
  });

  describe('5. idle → deploying → error (network failure)', () => {
    it('transitions to error when deployToken rejects', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
        new Error('network error')
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      await act(async () => {
        await expect(result.current.deploy(VALID_PARAMS)).rejects.toThrow();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error).not.toBeNull();
      expect(result.current.canRetry).toBe(true);
    });
  });

  describe('6. error → idle (recovery via reset)', () => {
    it('reset() transitions from error back to idle and clears error', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
        new Error('tx failed')
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      await act(async () => {
        await expect(result.current.deploy(VALID_PARAMS)).rejects.toThrow();
      });
      expect(result.current.status).toBe('error');

      act(() => { result.current.reset(); });

      expect(result.current.status).toBe('idle');
      expect(result.current.error).toBeNull();
      expect(result.current.retryCount).toBe(0);
      expect(result.current.canRetry).toBe(false);
    });
  });

  describe('7. error → success (recovery via retry)', () => {
    it('retry() re-enters deploying and reaches success on second attempt', async () => {
      let calls = 0;
      vi.mocked(StellarService.prototype.deployToken).mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('first attempt failed'));
        return Promise.resolve(DEPLOY_RESULT);
      });

      const { result } = renderHook(() =>
        useTokenDeploy(WALLET, { retryDelay: 0 })
      );

      await act(async () => {
        await expect(result.current.deploy(VALID_PARAMS)).rejects.toThrow();
      });
      expect(result.current.status).toBe('error');
      expect(result.current.canRetry).toBe(true);

      await act(async () => { await result.current.retry(); });

      expect(result.current.status).toBe('success');
      expect(result.current.retryCount).toBe(1);
    });
  });

  describe('8. No duplicate submissions', () => {
    it('canRetry is false while a deploy is in-flight (status=deploying)', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(DEPLOY_RESULT), 100))
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      act(() => { result.current.deploy(VALID_PARAMS); });
      await waitFor(() => expect(result.current.status).toBe('deploying'));

      // canRetry must be false while deploying — retry is only valid from error state
      expect(result.current.canRetry).toBe(false);

      await waitFor(() => expect(result.current.status).toBe('success'));
    });

    it('calling deploy twice in sequence does not corrupt state', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockResolvedValue(DEPLOY_RESULT);

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      // First deploy
      await act(async () => { await result.current.deploy(VALID_PARAMS); });
      expect(result.current.status).toBe('success');

      // Second deploy after first completes — should succeed cleanly
      await act(async () => { await result.current.deploy(VALID_PARAMS); });
      expect(result.current.status).toBe('success');
      expect(result.current.error).toBeNull();
    });
  });

  describe('9. maxRetries boundary', () => {
    it('canRetry becomes false after exhausting maxRetries', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
        new Error('always fails')
      );

      const { result } = renderHook(() =>
        useTokenDeploy(WALLET, { maxRetries: 2, retryDelay: 0 })
      );

      // Initial deploy
      await act(async () => {
        await expect(result.current.deploy(VALID_PARAMS)).rejects.toThrow();
      });
      expect(result.current.canRetry).toBe(true);

      // Retry 1
      await act(async () => {
        await expect(result.current.retry()).rejects.toThrow();
      });
      expect(result.current.retryCount).toBe(1);
      expect(result.current.canRetry).toBe(true);

      // Retry 2 — exhausts maxRetries
      await act(async () => {
        await expect(result.current.retry()).rejects.toThrow();
      });
      expect(result.current.retryCount).toBe(2);

      // Next retry returns null (maxRetries reached)
      let nullResult: any;
      await act(async () => {
        nullResult = await result.current.retry();
      });
      expect(nullResult).toBeNull();
      // canRetry is false — no more retries available
      expect(result.current.canRetry).toBe(false);
      // error is set (either the last deploy error or the maxRetries message)
      expect(result.current.error).not.toBeNull();
    });
  });
});
