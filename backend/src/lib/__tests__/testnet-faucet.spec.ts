import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
  generateTestKeypair,
  fundTestAccount,
  generateAndFundKeypair,
  FaucetError,
} from '../testnet-faucet';
import * as rateLimiter from '../../stellar-service-integration/rate-limiter';

vi.mock('axios');
vi.mock('../../stellar-service-integration/rate-limiter', () => ({
  calculateBackoffDelay: vi.fn(() => 0),
  isRetryableError: vi.fn(),
  sleep: vi.fn(() => Promise.resolve()),
}));

describe('testnet-faucet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateTestKeypair', () => {
    it('generates a valid Stellar keypair starting with G and S', () => {
      const keypair = generateTestKeypair();
      expect(keypair.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
      expect(keypair.secretKey).toMatch(/^S[A-Z2-7]{55}$/);
    });
  });

  describe('fundTestAccount', () => {
    it('throws FaucetError if network is not testnet', async () => {
      await expect(
        fundTestAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'mainnet')
      ).rejects.toThrow(FaucetError);
    });

    it('funds account successfully on testnet', async () => {
      vi.mocked(axios.get).mockResolvedValueOnce({
        data: { hash: 'tx-hash-123' },
      });

      const res = await fundTestAccount(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        'testnet'
      );
      expect(res).toEqual({ funded: true, transactionHash: 'tx-hash-123' });
      expect(axios.get).toHaveBeenCalledWith('https://friendbot.stellar.org', {
        params: { addr: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
        timeout: 15000,
      });
    });

    it('returns funded: true when friendbot responds with 400 (already funded)', async () => {
      vi.mocked(axios.get).mockRejectedValueOnce({
        response: { status: 400 },
      });

      const res = await fundTestAccount(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        'testnet'
      );
      expect(res).toEqual({ funded: true });
    });

    it('retries on retryable errors and throws FaucetError if attempts are exhausted', async () => {
      vi.mocked(rateLimiter.isRetryableError).mockReturnValue(true);
      vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

      const retryConfig = {
        maxAttempts: 2,
        initialDelay: 10,
        maxDelay: 50,
        backoffFactor: 2,
        jitterFactor: 0,
      };

      await expect(
        fundTestAccount(
          'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          'testnet',
          'https://friendbot.stellar.org',
          retryConfig
        )
      ).rejects.toThrow(FaucetError);

      expect(axios.get).toHaveBeenCalledTimes(2);
      expect(rateLimiter.sleep).toHaveBeenCalledTimes(1);
    });

    it('breaks immediately on non-retryable errors', async () => {
      vi.mocked(rateLimiter.isRetryableError).mockReturnValue(false);
      vi.mocked(axios.get).mockRejectedValue(new Error('Fatal 500 error'));

      const retryConfig = {
        maxAttempts: 3,
        initialDelay: 10,
        maxDelay: 50,
        backoffFactor: 2,
        jitterFactor: 0,
      };

      await expect(
        fundTestAccount(
          'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          'testnet',
          'https://friendbot.stellar.org',
          retryConfig
        )
      ).rejects.toThrow(FaucetError);

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(rateLimiter.sleep).not.toHaveBeenCalled();
    });
  });

  describe('generateAndFundKeypair', () => {
    it('generates a keypair and funds it successfully', async () => {
      vi.mocked(axios.get).mockResolvedValueOnce({
        data: { hash: 'hash-abc' },
      });

      const result = await generateAndFundKeypair('testnet');
      expect(result.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
      expect(result.secretKey).toMatch(/^S[A-Z2-7]{55}$/);
      expect(result.transactionHash).toBe('hash-abc');
    });
  });
});
