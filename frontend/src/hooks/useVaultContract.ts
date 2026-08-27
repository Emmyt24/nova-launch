import { useState, useCallback, useEffect } from 'react';
import type { 
  RecurringPayment, 
  RecurringPaymentHistory, 
  CreateRecurringPaymentParams,
  RecurringPaymentStatus,
  PaymentInterval
} from '../types';
import { vaultsApi } from '../services/vaultsApi';

// Interval presets in seconds
const INTERVAL_PRESETS: Record<Exclude<PaymentInterval, 'custom'>, number> = {
  hourly: 60 * 60, // 1 hour
  daily: 24 * 60 * 60, // 24 hours
  weekly: 7 * 24 * 60 * 60, // 7 days
  monthly: 30 * 24 * 60 * 60, // 30 days (approximate)
};

// Mock data for development - will be replaced with actual contract calls
const MOCK_PAYMENTS: RecurringPayment[] = [
  {
    id: '1',
    recipient: 'GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12',
    amount: '100.00',
    tokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    tokenSymbol: 'USDC',
    tokenDecimals: 7,
    memo: 'Monthly subscription',
    interval: 'monthly',
    intervalSeconds: INTERVAL_PRESETS.monthly,
    nextPaymentTime: Date.now() + 5 * 24 * 60 * 60 * 1000, // 5 days from now
    lastPaymentTime: Date.now() - 25 * 24 * 60 * 60 * 1000, // 25 days ago
    paymentCount: 3,
    totalPaid: '300.00',
    status: 'active',
    createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 days ago
    creator: 'GCREATOR1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12',
  },
  {
    id: '2',
    recipient: 'GHIJKL1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12',
    amount: '50.00',
    tokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    tokenSymbol: 'USDC',
    tokenDecimals: 7,
    memo: 'Weekly payroll',
    interval: 'weekly',
    intervalSeconds: INTERVAL_PRESETS.weekly,
    nextPaymentTime: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago (due)
    lastPaymentTime: Date.now() - 7 * 24 * 60 * 60 * 1000, // 7 days ago
    paymentCount: 15,
    totalPaid: '750.00',
    status: 'due',
    createdAt: Date.now() - 120 * 24 * 60 * 60 * 1000, // 120 days ago
    creator: 'GCREATOR1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12',
  },
  {
    id: '3',
    recipient: 'GMNOPQ1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12',
    amount: '25.00',
    tokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    tokenSymbol: 'USDC',
    tokenDecimals: 7,
    memo: 'Paused subscription',
    interval: 'daily',
    intervalSeconds: INTERVAL_PRESETS.daily,
    nextPaymentTime: Date.now() + 24 * 60 * 60 * 1000,
    lastPaymentTime: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
    paymentCount: 10,
    totalPaid: '250.00',
    status: 'paused',
    createdAt: Date.now() - 15 * 24 * 60 * 60 * 1000, // 15 days ago
    creator: 'GCREATOR1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12',
  },
];

const MOCK_HISTORY: RecurringPaymentHistory[] = [
  {
    id: 'h1',
    paymentId: '1',
    transactionHash: 'abc123def456789012345678901234567890123456789012345678901234',
    amount: '100.00',
    timestamp: Date.now() - 25 * 24 * 60 * 60 * 1000,
    status: 'success',
  },
  {
    id: 'h2',
    paymentId: '1',
    transactionHash: 'def456abc789012345678901234567890123456789012345678901234567',
    amount: '100.00',
    timestamp: Date.now() - 55 * 24 * 60 * 60 * 1000,
    status: 'success',
  },
  {
    id: 'h3',
    paymentId: '1',
    transactionHash: 'ghi789jkl012345678901234567890123456789012345678901234567890',
    amount: '100.00',
    timestamp: Date.now() - 85 * 24 * 60 * 60 * 1000,
    status: 'success',
  },
];

interface UseVaultContractOptions {
  network?: 'testnet' | 'mainnet';
  walletAddress?: string | null;
}

interface UseVaultContractReturn {
  payments: RecurringPayment[];
  loading: boolean;
  error: string | null;
  getRecurringPayments: () => Promise<RecurringPayment[]>;
  schedulePayment: (params: CreateRecurringPaymentParams) => Promise<RecurringPayment>;
  executeRecurringPayment: (paymentId: string) => Promise<{ success: boolean; txHash: string }>;
  cancelRecurringPayment: (paymentId: string) => Promise<{ success: boolean }>;
  pauseRecurringPayment: (paymentId: string) => Promise<{ success: boolean }>;
  resumeRecurringPayment: (paymentId: string) => Promise<{ success: boolean }>;
  getPaymentHistory: (paymentId: string) => Promise<RecurringPaymentHistory[]>;
  refreshPayments: () => Promise<void>;
}

export function useVaultContract(options: UseVaultContractOptions = {}): UseVaultContractReturn {
  // Network will be used for contract interactions when integrated
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { network = 'testnet', walletAddress } = options;
  const [payments, setPayments] = useState<RecurringPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Calculate payment status based on next payment time
  const calculateStatus = useCallback((payment: RecurringPayment): RecurringPaymentStatus => {
    if (payment.status === 'paused' || payment.status === 'cancelled') {
      return payment.status;
    }
    const now = Date.now();
    if (payment.nextPaymentTime <= now) {
      return 'due';
    }
    return 'active';
  }, []);

  // Fetch all recurring payments for the connected wallet
  const getRecurringPayments = useCallback(async (): Promise<RecurringPayment[]> => {
    setLoading(true);
    setError(null);

    try {
      if (!walletAddress) {
        setPayments([]);
        return [];
      }

      const vaultProjections = await vaultsApi.getByCreator(walletAddress);
      
      // Map VaultProjection to RecurringPayment for compatibility
      const mappedPayments: RecurringPayment[] = vaultProjections.map(v => ({
        id: v.streamId.toString(),
        recipient: v.recipient,
        amount: v.amount,
        tokenAddress: '', // Token info not in projection yet
        tokenSymbol: 'USDC',
        tokenDecimals: 7,
        interval: 'monthly', // Default for now
        intervalSeconds: INTERVAL_PRESETS.monthly,
        nextPaymentTime: Date.now() + INTERVAL_PRESETS.monthly * 1000,
        paymentCount: 0,
        totalPaid: '0.00',
        status: v.status.toLowerCase() as RecurringPaymentStatus,
        createdAt: new Date(v.createdAt).getTime(),
        creator: v.creator,
      }));
      
      setPayments(mappedPayments);
      return mappedPayments;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch recurring payments';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [calculateStatus]);

  // Schedule a new recurring payment
  const schedulePayment = useCallback(async (params: CreateRecurringPaymentParams): Promise<RecurringPayment> => {
    setLoading(true);
    setError(null);

    try {
      // Validate inputs
      if (!params.recipient || params.recipient.length !== 56) {
        throw new Error('Invalid recipient address');
      }
      if (!params.amount || parseFloat(params.amount) <= 0) {
        throw new Error('Amount must be greater than 0');
      }
      if (!params.tokenAddress) {
        throw new Error('Token address is required');
      }

      // Calculate interval in seconds
      const intervalSeconds = params.interval === 'custom' 
        ? params.customIntervalSeconds || 0 
        : INTERVAL_PRESETS[params.interval];

      if (intervalSeconds <= 0) {
        throw new Error('Invalid payment interval');
      }

      // TODO: Replace with actual contract call
      // const contract = await getVaultContract();
      // const result = await contract.schedule_payment({
      //   recipient: params.recipient,
      //   token: params.tokenAddress,
      //   amount: parseAmount(params.amount),
      //   memo: params.memo || '',
      //   interval: intervalSeconds,
      // });

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 1000));

      const newPayment: RecurringPayment = {
        id: `${Date.now()}`,
        recipient: params.recipient,
        amount: params.amount,
        tokenAddress: params.tokenAddress,
        tokenSymbol: 'USDC',
        tokenDecimals: 7,
        memo: params.memo,
        interval: params.interval,
        intervalSeconds,
        nextPaymentTime: Date.now() + intervalSeconds * 1000,
        paymentCount: 0,
        totalPaid: '0.00',
        status: 'active',
        createdAt: Date.now(),
        creator: walletAddress || '',
      };

      setPayments(prev => [...prev, newPayment]);
      return newPayment;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to schedule payment';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  // Execute a due recurring payment
  const executeRecurringPayment = useCallback(async (paymentId: string): Promise<{ success: boolean; txHash: string }> => {
    setLoading(true);
    setError(null);

    try {
      const payment = payments.find(p => p.id === paymentId);
      if (!payment) {
        throw new Error('Payment not found');
      }

      if (payment.status !== 'due' && payment.status !== 'active') {
        throw new Error('Payment is not in an executable state');
      }

      // TODO: Replace with actual contract call
      // const contract = await getVaultContract();
      // const result = await contract.execute_recurring_payment({ payment_id: paymentId });

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 1500));

      const txHash = `tx${Date.now()}${Math.random().toString(36).substring(2, 15)}`;

      // Update payment state
      setPayments(prev => prev.map(p => {
        if (p.id === paymentId) {
          return {
            ...p,
            nextPaymentTime: Date.now() + p.intervalSeconds * 1000,
            lastPaymentTime: Date.now(),
            paymentCount: p.paymentCount + 1,
            totalPaid: (parseFloat(p.totalPaid) + parseFloat(p.amount)).toFixed(2),
            status: 'active' as RecurringPaymentStatus,
          };
        }
        return p;
      }));

      return { success: true, txHash };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to execute payment';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [payments]);

  // Cancel a recurring payment
  const cancelRecurringPayment = useCallback(async (paymentId: string): Promise<{ success: boolean }> => {
    setLoading(true);
    setError(null);

    try {
      const payment = payments.find(p => p.id === paymentId);
      if (!payment) {
        throw new Error('Payment not found');
      }

      // TODO: Replace with actual contract call
      // const contract = await getVaultContract();
      // await contract.cancel_recurring_payment({ payment_id: paymentId });

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 800));

      setPayments(prev => prev.map(p => {
        if (p.id === paymentId) {
          return { ...p, status: 'cancelled' as RecurringPaymentStatus };
        }
        return p;
      }));

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel payment';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [payments]);

  // Pause a recurring payment
  const pauseRecurringPayment = useCallback(async (paymentId: string): Promise<{ success: boolean }> => {
    setLoading(true);
    setError(null);

    try {
      const payment = payments.find(p => p.id === paymentId);
      if (!payment) {
        throw new Error('Payment not found');
      }

      // TODO: Replace with actual contract call
      // const contract = await getVaultContract();
      // await contract.pause_recurring_payment({ payment_id: paymentId });

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 600));

      setPayments(prev => prev.map(p => {
        if (p.id === paymentId) {
          return { ...p, status: 'paused' as RecurringPaymentStatus };
        }
        return p;
      }));

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to pause payment';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [payments]);

  // Resume a paused recurring payment
  const resumeRecurringPayment = useCallback(async (paymentId: string): Promise<{ success: boolean }> => {
    setLoading(true);
    setError(null);

    try {
      const payment = payments.find(p => p.id === paymentId);
      if (!payment) {
        throw new Error('Payment not found');
      }

      if (payment.status !== 'paused') {
        throw new Error('Payment is not paused');
      }

      // TODO: Replace with actual contract call
      // const contract = await getVaultContract();
      // await contract.resume_recurring_payment({ payment_id: paymentId });

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 600));

      setPayments(prev => prev.map(p => {
        if (p.id === paymentId) {
          // Recalculate next payment time from now
          const nextPaymentTime = Date.now() + p.intervalSeconds * 1000;
          return { 
            ...p, 
            status: 'active' as RecurringPaymentStatus,
            nextPaymentTime,
          };
        }
        return p;
      }));

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resume payment';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [payments]);

  // Get payment history for a specific recurring payment
  const getPaymentHistory = useCallback(async (paymentId: string): Promise<RecurringPaymentHistory[]> => {
    setLoading(true);
    setError(null);

    try {
      // TODO: Replace with actual contract call
      // const contract = await getVaultContract();
      // const history = await contract.get_payment_history({ payment_id: paymentId });

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 400));

      // Return mock history filtered by paymentId
      return MOCK_HISTORY.filter(h => h.paymentId === paymentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch payment history';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh payments
  const refreshPayments = useCallback(async () => {
    await getRecurringPayments();
  }, [getRecurringPayments]);

  // Initial fetch when wallet connects
  useEffect(() => {
    if (walletAddress) {
      getRecurringPayments().catch(console.error);
    }
  }, [walletAddress, getRecurringPayments]);

  return {
    payments,
    loading,
    error,
    getRecurringPayments,
    schedulePayment,
    executeRecurringPayment,
    cancelRecurringPayment,
    pauseRecurringPayment,
    resumeRecurringPayment,
    getPaymentHistory,
    refreshPayments,
  };
}

// Utility function to format interval for display
export function formatInterval(interval: PaymentInterval, seconds?: number): string {
  switch (interval) {
    case 'hourly':
      return 'Every hour';
    case 'daily':
      return 'Every day';
    case 'weekly':
      return 'Every week';
    case 'monthly':
      return 'Every month';
    case 'custom':
      if (seconds) {
        const hours = Math.floor(seconds / 3600);
        const days = Math.floor(hours / 24);
        if (days > 0) {
          return `Every ${days} day${days > 1 ? 's' : ''}`;
        }
        return `Every ${hours} hour${hours > 1 ? 's' : ''}`;
      }
      return 'Custom interval';
    default:
      return 'Unknown';
  }
}

// Utility function to format countdown
export function formatCountdown(targetTime: number): string {
  const now = Date.now();
  const diff = targetTime - now;

  if (diff <= 0) {
    return 'Due now';
  }

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

// Utility function to truncate address
export function truncateAddress(address: string, chars = 8): string {
  if (address.length <= chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

// Get Stellar Expert URL for transaction
export function getStellarExpertUrl(txHash: string, network: 'testnet' | 'mainnet' = 'testnet'): string {
  const baseUrl = network === 'mainnet' 
    ? 'https://stellar.expert/explorer/public/tx' 
    : 'https://stellar.expert/explorer/testnet/tx';
  return `${baseUrl}/${txHash}`;
}

// ─── Vesting claim flow ────────────────────────────────────────────────────────

import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  rpc as Soroban,
  Transaction,
} from '@stellar/stellar-sdk';
import { getNetworkConfig, STELLAR_CONFIG } from '../config/stellar';
import { WalletService } from '../services/wallet';

export interface ClaimVaultResult {
  txHash: string;
}

/**
 * Submit a claim_stream transaction for the given streamId.
 * Throws if the wallet is not connected, simulation fails, or the tx is rejected.
 */
export async function claimVault(
  streamId: number,
  claimerAddress: string,
  network: 'testnet' | 'mainnet' = 'testnet',
): Promise<ClaimVaultResult> {
  const config = getNetworkConfig(network);
  const server = new Soroban.Server(config.sorobanRpcUrl);
  const contractId = STELLAR_CONFIG.factoryContractId;

  const contract = new Contract(contractId);

  const account = await server.getAccount(claimerAddress);
  const operation = contract.call(
    'claim_stream',
    nativeToScVal(claimerAddress, { type: 'address' }),
    nativeToScVal(streamId, { type: 'u64' }),
  );

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const signedXdr = await WalletService.signTransaction(prepared.toXDR());
  if (!signedXdr) {
    throw new Error('claim_stream transaction signing was rejected or cancelled');
  }
  const signedTx = TransactionBuilder.fromXDR(
    signedXdr,
    config.networkPassphrase,
  ) as Transaction;

  const response = await server.sendTransaction(signedTx);
  if (response.status === 'ERROR') {
    throw new Error('claim_stream transaction failed');
  }

  // Poll for confirmation
  let getResponse = await server.getTransaction(response.hash);
  while (getResponse.status === 'NOT_FOUND') {
    await new Promise((r) => setTimeout(r, 1000));
    getResponse = await server.getTransaction(response.hash);
  }
  if (getResponse.status === 'FAILED') {
    throw new Error('claim_stream transaction failed on-chain');
  }

  return { txHash: response.hash };
}
