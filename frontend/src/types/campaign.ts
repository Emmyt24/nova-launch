/**
 * Campaign Types
 * Defines all types related to campaign creation and management
 */

export interface CampaignParams {
  title: string;
  description: string;
  budget: string; // in XLM
  duration: number; // in seconds
  slippage: number; // percentage (0-100)
  creatorAddress: string;
  tokenAddress: string;
}

export interface CampaignCreationResult {
  campaignId: string;
  transactionHash: string;
  timestamp: number;
  totalCost: string;
}

export interface CampaignValidationError {
  field: string;
  message: string;
}

export type CampaignStatus = 'idle' | 'validating' | 'submitting' | 'success' | 'error';

export interface CampaignFormState {
  title: string;
  description: string;
  budget: string;
  duration: number;
  slippage: number;
  errors: Record<string, string>;
  touched: Record<string, boolean>;
}

export interface ContractError {
  code: number;
  message: string;
  userMessage: string;
  details?: string;
}

export interface CampaignFeeBreakdown {
  baseFee: string; // in XLM
  estimatedGasFee: string; // in XLM
  totalFee: string; // in XLM
}

export interface CampaignFormData {
  title: string;
  description: string;
  budget: string;
  duration: number;
  slippage: number;
}

export interface CampaignTransactionState {
  hash: string;
  status: 'pending' | 'success' | 'failed' | 'timeout';
  timestamp: number;
  error?: string;
}
