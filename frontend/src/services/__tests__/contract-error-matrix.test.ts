import { describe, it, expect } from 'vitest';
import {
  parseStellarError,
  CONTRACT_ERROR_MAP,
  StellarError,
} from '../stellarErrors';
import { ErrorCode } from '../../types';

/**
 * Contract Error Matrix Tests
 * 
 * Verifies that contract error handling aligns with docs/CONTRACT_ERROR_MATRIX.md
 * 
 * Tests:
 * - Known contract codes map consistently to user-facing messages
 * - Unknown errors preserve raw details
 * - Wallet rejection stays distinct from contract rejection
 * - All error categories are covered (token, campaign, governance, vault, stream)
 */

describe('Contract Error Matrix', () => {
  describe('Known Contract Error Mapping', () => {
    it('maps TOKEN_ALREADY_EXISTS correctly', () => {
      const error = { message: 'Error(TOKEN_ALREADY_EXISTS)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.CONTRACT_ERROR);
      expect(stellarError.message).toBe('This token symbol is already in use');
      expect(stellarError.details).toBe('Token with symbol already deployed');
      expect(stellarError.retryable).toBe(false);
      expect(stellarError.retrySuggestion).toBe('Choose a different symbol for your token');
      expect(stellarError.transactionFailure?.contractErrorCode).toBe('TOKEN_ALREADY_EXISTS');
    });

    it('maps UNAUTHORIZED_BURN correctly', () => {
      const error = { message: 'Error(UNAUTHORIZED_BURN)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(stellarError.message).toBe('You are not authorized to burn this token');
      expect(stellarError.retryable).toBe(false);
      expect(stellarError.severity).toBe('high');
    });

    it('maps BURN_AMOUNT_EXCEEDS_BALANCE correctly', () => {
      const error = { message: 'Error(BURN_AMOUNT_EXCEEDS_BALANCE)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.INVALID_AMOUNT);
      expect(stellarError.message).toBe('Burn amount exceeds your token balance');
      expect(stellarError.retryable).toBe(false);
    });

    it('maps CAMPAIGN_NOT_FOUND correctly', () => {
      const error = { message: 'Error(CAMPAIGN_NOT_FOUND)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.CONTRACT_ERROR);
      expect(stellarError.message).toBe('Campaign not found');
      expect(stellarError.details).toBe('Campaign ID does not exist');
    });

    it('maps INSUFFICIENT_BUDGET correctly', () => {
      const error = { message: 'Error(INSUFFICIENT_BUDGET)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);
      expect(stellarError.message).toBe('Campaign budget has been exhausted');
      expect(stellarError.severity).toBe('high');
    });

    it('maps MIN_INTERVAL_NOT_MET as retryable', () => {
      const error = { message: 'Error(MIN_INTERVAL_NOT_MET)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.retryable).toBe(true);
      expect(stellarError.retrySuggestion).toBe('Wait before executing the next campaign step');
    });

    it('maps PROPOSAL_NOT_FOUND correctly', () => {
      const error = { message: 'Error(PROPOSAL_NOT_FOUND)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.CONTRACT_ERROR);
      expect(stellarError.message).toBe('Proposal not found');
    });

    it('maps ALREADY_VOTED correctly', () => {
      const error = { message: 'Error(ALREADY_VOTED)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.message).toBe('You have already voted on this proposal');
      expect(stellarError.retryable).toBe(false);
    });

    it('maps INSUFFICIENT_VOTING_POWER correctly', () => {
      const error = { message: 'Error(INSUFFICIENT_VOTING_POWER)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);
      expect(stellarError.severity).toBe('high');
    });

    it('maps VAULT_ALREADY_CLAIMED correctly', () => {
      const error = { message: 'Error(VAULT_ALREADY_CLAIMED)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.message).toBe('This vault has already been claimed');
      expect(stellarError.retryable).toBe(false);
    });

    it('maps STREAM_NOT_FOUND correctly', () => {
      const error = { message: 'Error(STREAM_NOT_FOUND)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.message).toBe('Payment stream not found');
      expect(stellarError.details).toBe('Stream ID does not exist');
    });

    it('maps CONTRACT_PAUSED as critical and retryable', () => {
      const error = { message: 'Error(CONTRACT_PAUSED)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.message).toBe('Protocol is currently paused for maintenance');
      expect(stellarError.retryable).toBe(true);
      expect(stellarError.severity).toBe('critical');
    });
  });

  describe('Unknown Contract Errors', () => {
    it('preserves raw details for unknown error codes', () => {
      const error = { message: 'Error(UNKNOWN_ERROR_CODE_XYZ)' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.CONTRACT_ERROR);
      expect(stellarError.message).toBe('Smart contract error occurred');
      expect(stellarError.details).toContain('UNKNOWN_ERROR_CODE_XYZ');
      expect(stellarError.retryable).toBe(true);
      expect(stellarError.transactionFailure?.contractErrorCode).toBe('UNKNOWN_ERROR_CODE_XYZ');
      expect(stellarError.transactionFailure?.rawError).toBeDefined();
    });

    it('handles errors without Error() wrapper', () => {
      const error = { message: 'Some contract failure', contractErrorCode: 'CUSTOM_ERROR' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.CONTRACT_ERROR);
      expect(stellarError.details).toContain('CUSTOM_ERROR');
      expect(stellarError.transactionFailure?.rawError).toBeDefined();
    });

    it('preserves error details when no error code is found', () => {
      const error = { message: 'Contract execution failed unexpectedly' };
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.CONTRACT_ERROR);
      expect(stellarError.details).toContain('Contract execution failed unexpectedly');
    });
  });

  describe('Wallet Rejection vs Contract Rejection', () => {
    it('identifies wallet rejection (user declined)', () => {
      const error = new Error('User declined to sign the transaction');
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.WALLET_REJECTED);
      expect(stellarError.message).toBe('Transaction was cancelled');
      expect(stellarError.details).toBe('You cancelled the transaction in your wallet');
      expect(stellarError.retryable).toBe(true);
    });

    it('identifies wallet rejection (rejected)', () => {
      const error = new Error('Transaction rejected by user');
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.WALLET_REJECTED);
      expect(stellarError.retryable).toBe(true);
    });

    it('identifies wallet rejection (cancelled)', () => {
      const error = new Error('Transaction cancelled by user');
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.WALLET_REJECTED);
    });

    it('distinguishes contract rejection from wallet rejection', () => {
      const contractError = { message: 'Error(UNAUTHORIZED_BURN)' };
      const stellarError = parseStellarError(contractError);

      expect(stellarError.code).not.toBe(ErrorCode.WALLET_REJECTED);
      expect(stellarError.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(stellarError.message).not.toContain('cancelled');
    });

    it('wallet rejection takes precedence over contract errors', () => {
      // If both patterns exist, wallet rejection should be detected first
      const error = new Error('User declined: Error(SOME_CONTRACT_ERROR)');
      const stellarError = parseStellarError(error);

      expect(stellarError.code).toBe(ErrorCode.WALLET_REJECTED);
    });
  });

  describe('Error Category Coverage', () => {
    it('covers all token error codes', () => {
      const tokenErrors = [
        'TOKEN_ALREADY_EXISTS',
        'INVALID_TOKEN_PARAMS',
        'TOKEN_NOT_FOUND',
        'UNAUTHORIZED_BURN',
        'BURN_AMOUNT_EXCEEDS_BALANCE',
        'ZERO_BURN_AMOUNT',
        'METADATA_TOO_LARGE',
        'INVALID_METADATA_URI',
      ];

      tokenErrors.forEach(errorCode => {
        expect(CONTRACT_ERROR_MAP[errorCode]).toBeDefined();
        expect(CONTRACT_ERROR_MAP[errorCode].message).toBeTruthy();
        expect(CONTRACT_ERROR_MAP[errorCode].details).toBeTruthy();
        expect(CONTRACT_ERROR_MAP[errorCode].retrySuggestion).toBeTruthy();
      });
    });

    it('covers all campaign error codes', () => {
      const campaignErrors = [
        'CAMPAIGN_NOT_FOUND',
        'CAMPAIGN_ALREADY_EXISTS',
        'CAMPAIGN_NOT_ACTIVE',
        'CAMPAIGN_ENDED',
        'INSUFFICIENT_BUDGET',
        'INVALID_TIME_RANGE',
        'INVALID_SLIPPAGE',
        'UNAUTHORIZED_CREATOR',
        'MIN_INTERVAL_NOT_MET',
      ];

      campaignErrors.forEach(errorCode => {
        expect(CONTRACT_ERROR_MAP[errorCode]).toBeDefined();
        expect(CONTRACT_ERROR_MAP[errorCode].severity).toBeTruthy();
      });
    });

    it('covers all governance error codes', () => {
      const governanceErrors = [
        'PROPOSAL_NOT_FOUND',
        'VOTING_NOT_STARTED',
        'VOTING_ENDED',
        'ALREADY_VOTED',
        'INSUFFICIENT_VOTING_POWER',
        'QUORUM_NOT_MET',
        'UNAUTHORIZED_PROPOSER',
      ];

      governanceErrors.forEach(errorCode => {
        expect(CONTRACT_ERROR_MAP[errorCode]).toBeDefined();
      });
    });

    it('covers all vault error codes', () => {
      const vaultErrors = [
        'VAULT_NOT_FOUND',
        'VAULT_ALREADY_CLAIMED',
        'UNAUTHORIZED_CLAIMER',
      ];

      vaultErrors.forEach(errorCode => {
        expect(CONTRACT_ERROR_MAP[errorCode]).toBeDefined();
      });
    });

    it('covers all stream error codes', () => {
      const streamErrors = [
        'STREAM_NOT_FOUND',
        'STREAM_ALREADY_CLAIMED',
        'UNAUTHORIZED_STREAM_CLAIMER',
      ];

      streamErrors.forEach(errorCode => {
        expect(CONTRACT_ERROR_MAP[errorCode]).toBeDefined();
      });
    });

    it('covers system error codes', () => {
      expect(CONTRACT_ERROR_MAP['CONTRACT_PAUSED']).toBeDefined();
      expect(CONTRACT_ERROR_MAP['CONTRACT_PAUSED'].severity).toBe('critical');
    });
  });

  describe('Error Consistency', () => {
    it('all mapped errors have required fields', () => {
      Object.entries(CONTRACT_ERROR_MAP).forEach(([errorCode, mapping]) => {
        expect(mapping.code).toBeDefined();
        expect(mapping.message).toBeTruthy();
        expect(mapping.details).toBeTruthy();
        expect(typeof mapping.retryable).toBe('boolean');
        expect(mapping.retrySuggestion).toBeTruthy();
        expect(mapping.severity).toMatch(/^(low|medium|high|critical)$/);
      });
    });

    it('retryable errors have appropriate suggestions', () => {
      Object.entries(CONTRACT_ERROR_MAP).forEach(([errorCode, mapping]) => {
        if (mapping.retryable) {
          expect(mapping.retrySuggestion.toLowerCase()).toMatch(/wait|try|retry/);
        }
      });
    });

    it('high severity errors are not retryable', () => {
      Object.entries(CONTRACT_ERROR_MAP).forEach(([errorCode, mapping]) => {
        if (mapping.severity === 'high' || mapping.severity === 'critical') {
          // Most high/critical errors should not be retryable
          // Exception: CONTRACT_PAUSED is critical but retryable
          if (errorCode !== 'CONTRACT_PAUSED') {
            expect(mapping.retryable).toBe(false);
          }
        }
      });
    });
  });

  describe('Transaction Failure Details', () => {
    it('includes transaction failure details when provided', () => {
      const error = { message: 'Error(TOKEN_ALREADY_EXISTS)' };
      const transactionResponse = {
        status: 'FAILED',
        resultXdr: 'some_xdr_data',
        diagnosticEventsXdr: ['event1', 'event2'],
      };

      const stellarError = parseStellarError(error, transactionResponse);

      expect(stellarError.transactionFailure).toBeDefined();
      expect(stellarError.transactionFailure?.contractErrorCode).toBe('TOKEN_ALREADY_EXISTS');
      expect(stellarError.transactionFailure?.diagnosticEvents).toEqual(['event1', 'event2']);
    });

    it('preserves raw error in transaction failure', () => {
      const error = { message: 'Error(UNKNOWN_CODE)', details: 'Additional context' };
      const stellarError = parseStellarError(error);

      expect(stellarError.transactionFailure?.rawError).toBeDefined();
      expect(stellarError.transactionFailure?.rawError).toContain('UNKNOWN_CODE');
    });
  });
});
