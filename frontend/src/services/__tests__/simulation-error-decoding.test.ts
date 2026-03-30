import { describe, it, expect } from 'vitest';
import { decodeSimulationError } from '../stellarErrors';
import { ErrorCode } from '../../types';

describe('decodeSimulationError', () => {
  it('maps numeric contract error code 1 (InsufficientFee) to INSUFFICIENT_BALANCE', () => {
    const sim = { error: 'Error(Contract, #1)' };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);
    expect(result.userMessage).toBeTruthy();
    expect(result.retryable).toBe(true);
  });

  it('maps numeric contract error code 7 (BurnAmountExceedsBalance) to INVALID_AMOUNT', () => {
    const sim = { error: 'Error(Contract, #7)' };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.INVALID_AMOUNT);
    expect(result.userMessage).toMatch(/burn amount/i);
  });

  it('maps numeric contract error code 2 (Unauthorized) to UNAUTHORIZED', () => {
    const sim = { error: 'Error(Contract, #2)' };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('maps symbolic error key TOKEN_NOT_FOUND', () => {
    const sim = { error: 'Error(TOKEN_NOT_FOUND)' };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.CONTRACT_ERROR);
    expect(result.userMessage).toMatch(/token not found/i);
  });

  it('maps symbolic error key ALREADY_VOTED', () => {
    const sim = { error: 'Error(ALREADY_VOTED)' };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.CONTRACT_ERROR);
    expect(result.userMessage).toMatch(/already voted/i);
  });

  it('maps symbolic error key CAMPAIGN_ENDED', () => {
    const sim = { error: 'Error(CAMPAIGN_ENDED)' };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.CONTRACT_ERROR);
    expect(result.userMessage).toMatch(/campaign/i);
  });

  it('maps insufficient fee heuristic when no symbolic code present', () => {
    const sim = { error: 'insufficient fee for transaction' };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);
    expect(result.retryable).toBe(true);
  });

  it('falls back to SIMULATION_FAILED for unknown errors and preserves raw detail', () => {
    const sim = { error: 'some completely unknown error xyz' };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.SIMULATION_FAILED);
    expect(result.debugDetail).toContain('unknown error xyz');
    expect(result.retryable).toBe(true);
  });

  it('reads error from result.error when top-level error is absent', () => {
    const sim = { result: { error: 'Error(Contract, #9)' } };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.INVALID_AMOUNT);
  });

  it('always populates debugDetail with raw JSON', () => {
    const sim = { error: 'Error(Contract, #3)', extra: 'data' };
    const result = decodeSimulationError(sim);
    expect(result.debugDetail).toContain('"extra"');
  });

  it('maps vault error code 60 (VaultNotFound)', () => {
    const sim = { error: 'Error(Contract, #60)' };
    const result = decodeSimulationError(sim);
    expect(result.code).toBe(ErrorCode.CONTRACT_ERROR);
    expect(result.userMessage).toMatch(/vault not found/i);
  });
});
