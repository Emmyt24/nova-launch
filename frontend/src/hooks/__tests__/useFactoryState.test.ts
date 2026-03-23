/**
 * Factory State Hook Tests
 * 
 * Tests pause state detection and monitoring
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useFactoryState } from '../useFactoryState';
import * as stellarSdk from '@stellar/stellar-sdk';

// Mock Stellar SDK
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Contract: vi.fn(),
    TransactionBuilder: vi.fn(),
    Keypair: {
      random: vi.fn(),
    },
  };
});

// Mock config
vi.mock('../../config/stellar', () => ({
  STELLAR_CONFIG: {
    factoryContractId: 'CTEST123',
  },
  getNetworkConfig: vi.fn(() => ({
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  })),
}));

describe('useFactoryState', () => {
  let mockServer: any;
  let mockContract: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock server
    mockServer = {
      getAccount: vi.fn(),
      simulateTransaction: vi.fn(),
    };

    // Mock contract
    mockContract = {
      call: vi.fn(),
    };

    // Setup mocks
    vi.mocked(stellarSdk.Contract).mockReturnValue(mockContract as any);
    
    const mockKeypair = {
      publicKey: () => 'GTEST123',
      secret: () => 'STEST123',
    };
    vi.mocked(stellarSdk.Keypair.random).mockReturnValue(mockKeypair as any);

    // Mock TransactionBuilder
    const mockTx = {
      build: vi.fn().mockReturnThis(),
    };
    const mockBuilder = {
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue(mockTx),
    };
    vi.mocked(stellarSdk.TransactionBuilder).mockReturnValue(mockBuilder as any);

    // Mock rpc.Server
    (stellarSdk as any).rpc = {
      Server: vi.fn(() => mockServer),
      Api: {
        isSimulationSuccess: vi.fn(),
      },
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('Pause State Detection', () => {
    it('should detect when contract is not paused', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => false,
          },
        },
      });
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      const { result } = renderHook(() => useFactoryState({ pollingInterval: 0 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.isPaused).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.lastChecked).toBeGreaterThan(0);
    });

    it('should detect when contract is paused', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => true,
          },
        },
      });
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      const { result } = renderHook(() => useFactoryState({ pollingInterval: 0 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.isPaused).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('should handle simulation errors', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockRejectedValue(new Error('Simulation failed'));

      const { result } = renderHook(() => useFactoryState({ pollingInterval: 0 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBeTruthy();
      expect(result.current.error).toContain('Simulation failed');
    });

    it('should handle missing contract ID', async () => {
      vi.doMock('../../config/stellar', () => ({
        STELLAR_CONFIG: {
          factoryContractId: '',
        },
        getNetworkConfig: vi.fn(() => ({
          sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
          networkPassphrase: 'Test SDF Network ; September 2015',
          horizonUrl: 'https://horizon-testnet.stellar.org',
        })),
      }));

      const { result } = renderHook(() => useFactoryState({ pollingInterval: 0 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBeTruthy();
    });
  });

  describe('Polling Behavior', () => {
    it('should not poll when pollingInterval is 0', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => false,
          },
        },
      });
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      renderHook(() => useFactoryState({ pollingInterval: 0 }));

      await waitFor(() => {
        expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
      });

      // Wait a bit more to ensure no additional calls
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('should poll at specified interval', async () => {
      vi.useFakeTimers();

      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => false,
          },
        },
      });
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      renderHook(() => useFactoryState({ pollingInterval: 1000 }));

      // Initial call
      await waitFor(() => {
        expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
      });

      // Advance time and check for second call
      vi.advanceTimersByTime(1000);
      await waitFor(() => {
        expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(2);
      });

      vi.useRealTimers();
    });

    it('should stop polling on unmount', async () => {
      vi.useFakeTimers();

      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => false,
          },
        },
      });
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      const { unmount } = renderHook(() => useFactoryState({ pollingInterval: 1000 }));

      await waitFor(() => {
        expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
      });

      unmount();

      // Advance time after unmount
      vi.advanceTimersByTime(2000);
      
      // Should not have made additional calls
      expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('Manual Refresh', () => {
    it('should allow manual refresh', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => false,
          },
        },
      });
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      const { result } = renderHook(() => useFactoryState({ pollingInterval: 0 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);

      // Manual refresh
      await result.current.refresh();

      expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(2);
    });

    it('should update state after manual refresh', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      
      // First call: not paused
      mockServer.simulateTransaction.mockResolvedValueOnce({
        result: {
          retval: {
            value: () => false,
          },
        },
      });
      
      // Second call: paused
      mockServer.simulateTransaction.mockResolvedValueOnce({
        result: {
          retval: {
            value: () => true,
          },
        },
      });
      
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      const { result } = renderHook(() => useFactoryState({ pollingInterval: 0 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.isPaused).toBe(false);

      // Manual refresh
      await result.current.refresh();

      await waitFor(() => {
        expect(result.current.isPaused).toBe(true);
      });
    });
  });

  describe('Network Selection', () => {
    it('should work with testnet', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => false,
          },
        },
      });
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      const { result } = renderHook(() => useFactoryState({ 
        network: 'testnet',
        pollingInterval: 0 
      }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.isPaused).toBe(false);
    });

    it('should work with mainnet', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => false,
          },
        },
      });
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      const { result } = renderHook(() => useFactoryState({ 
        network: 'mainnet',
        pollingInterval: 0 
      }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.isPaused).toBe(false);
    });
  });

  describe('Enabled Flag', () => {
    it('should not fetch when enabled is false', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => false,
          },
        },
      });

      renderHook(() => useFactoryState({ enabled: false, pollingInterval: 0 }));

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockServer.simulateTransaction).not.toHaveBeenCalled();
    });

    it('should fetch when enabled is true', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Account not found'));
      mockServer.simulateTransaction.mockResolvedValue({
        result: {
          retval: {
            value: () => false,
          },
        },
      });
      (stellarSdk as any).rpc.Api.isSimulationSuccess.mockReturnValue(true);

      renderHook(() => useFactoryState({ enabled: true, pollingInterval: 0 }));

      await waitFor(() => {
        expect(mockServer.simulateTransaction).toHaveBeenCalled();
      });
    });
  });
});
