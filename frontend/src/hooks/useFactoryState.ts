/**
 * Factory State Hook
 * 
 * Reads and monitors the factory contract's pause state to prevent
 * users from submitting transactions that will fail due to protocol maintenance.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Contract, TransactionBuilder, BASE_FEE, Keypair } from '@stellar/stellar-sdk';
import { rpc as Soroban } from '@stellar/stellar-sdk';
import { STELLAR_CONFIG, getNetworkConfig } from '../config/stellar';

export interface FactoryState {
  isPaused: boolean;
  loading: boolean;
  error: string | null;
  lastChecked: number | null;
}

interface UseFactoryStateOptions {
  network?: 'testnet' | 'mainnet';
  pollingInterval?: number; // milliseconds, 0 to disable polling
  enabled?: boolean; // whether to fetch state
}

const DEFAULT_POLLING_INTERVAL = 30000; // 30 seconds

/**
 * Hook to read and monitor factory contract pause state
 * 
 * Features:
 * - Reads pause state directly from chain (no stale cache)
 * - Optional polling for real-time updates
 * - Manual refresh capability
 * - Automatic cleanup on unmount
 */
export function useFactoryState(options: UseFactoryStateOptions = {}) {
  const {
    network = 'testnet',
    pollingInterval = DEFAULT_POLLING_INTERVAL,
    enabled = true,
  } = options;

  const [state, setState] = useState<FactoryState>({
    isPaused: false,
    loading: true,
    error: null,
    lastChecked: null,
  });

  const pollingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  /**
   * Check if factory contract is paused
   */
  const checkPauseState = useCallback(async (): Promise<boolean> => {
    const contractId = STELLAR_CONFIG.factoryContractId;
    if (!contractId) {
      throw new Error('Factory contract ID not configured');
    }

    const config = getNetworkConfig(network);
    const server = new Soroban.Server(config.sorobanRpcUrl);
    const contract = new Contract(contractId);

    // Create a dummy account for simulation
    const dummyKeypair = Keypair.random();
    const dummyAccount = await server.getAccount(dummyKeypair.publicKey()).catch(() => {
      // If account doesn't exist, create a minimal account object
      return {
        accountId: () => dummyKeypair.publicKey(),
        sequenceNumber: () => '0',
        incrementSequenceNumber: () => {},
      } as any;
    });

    // Build transaction to call is_paused
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(contract.call('is_paused'))
      .setTimeout(30)
      .build();

    // Simulate the transaction
    const simulated = await server.simulateTransaction(tx);

    if (Soroban.Api.isSimulationSuccess(simulated) && simulated.result) {
      // Parse the boolean result
      const result = simulated.result.retval;
      
      // ScVal boolean is represented as { switch: () => 'scvBool', value: () => boolean }
      if (result && typeof result === 'object' && 'value' in result) {
        return Boolean((result as any).value());
      }
      
      return false;
    }

    throw new Error('Failed to simulate is_paused call');
  }, [network]);

  /**
   * Fetch pause state from contract
   */
  const fetchPauseState = useCallback(async () => {
    if (!enabled) return;

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const isPaused = await checkPauseState();
      
      if (isMountedRef.current) {
        setState({
          isPaused,
          loading: false,
          error: null,
          lastChecked: Date.now(),
        });
      }
    } catch (error) {
      console.error('Failed to fetch factory pause state:', error);
      
      if (isMountedRef.current) {
        setState(prev => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to check pause state',
          lastChecked: Date.now(),
        }));
      }
    }
  }, [enabled, checkPauseState]);

  /**
   * Manual refresh function
   */
  const refresh = useCallback(() => {
    return fetchPauseState();
  }, [fetchPauseState]);

  /**
   * Setup polling
   */
  useEffect(() => {
    if (!enabled) return;

    // Initial fetch
    fetchPauseState();

    // Setup polling if interval > 0
    if (pollingInterval > 0) {
      pollingTimerRef.current = setInterval(() => {
        fetchPauseState();
      }, pollingInterval);
    }

    // Cleanup
    return () => {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [enabled, pollingInterval, fetchPauseState]);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
      }
    };
  }, []);

  return {
    ...state,
    refresh,
  };
}
