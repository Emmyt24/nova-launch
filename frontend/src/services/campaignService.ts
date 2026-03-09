/**
 * Campaign Service
 * Handles campaign creation and contract interaction
 */

import { StellarService } from './stellar.service';
import type { CampaignParams, CampaignCreationResult, CampaignFeeBreakdown, ContractError } from '../types/campaign';
import type { AppError } from '../types';
import { ErrorCode } from '../types';

const CONTRACT_ERROR_MAP: Record<number, ContractError> = {
  1: {
    code: 1,
    message: 'Invalid campaign parameters',
    userMessage: 'Please check your campaign details and try again',
  },
  2: {
    code: 2,
    message: 'Insufficient balance for campaign budget',
    userMessage: 'Your wallet does not have enough funds for this campaign',
  },
  3: {
    code: 3,
    message: 'Campaign duration too short',
    userMessage: 'Campaign must run for at least 1 hour',
  },
  4: {
    code: 4,
    message: 'Campaign duration too long',
    userMessage: 'Campaign cannot exceed 1 year',
  },
  5: {
    code: 5,
    message: 'Invalid slippage value',
    userMessage: 'Slippage must be between 0% and 100%',
  },
  6: {
    code: 6,
    message: 'Token not found',
    userMessage: 'The specified token does not exist',
  },
  7: {
    code: 7,
    message: 'Unauthorized creator',
    userMessage: 'You are not authorized to create campaigns for this token',
  },
  8: {
    code: 8,
    message: 'Campaign already exists',
    userMessage: 'A campaign with this ID already exists',
  },
};

export class CampaignService {
  private stellar: StellarService;

  constructor(network: 'testnet' | 'mainnet' = 'testnet') {
    this.stellar = new StellarService(network);
  }

  /**
   * Calculate campaign creation fees
   */
  calculateFees(): CampaignFeeBreakdown {
    const baseFee = '0.5'; // 0.5 XLM base fee
    const estimatedGasFee = '0.1'; // 0.1 XLM estimated gas
    const totalFee = (parseFloat(baseFee) + parseFloat(estimatedGasFee)).toString();

    return {
      baseFee,
      estimatedGasFee,
      totalFee,
    };
  }

  /**
   * Create a campaign
   */
  async createCampaign(params: CampaignParams): Promise<CampaignCreationResult> {
    try {
      // Validate parameters
      this.validateCampaignParams(params);

      // Call contract to create campaign
      const txHash = await this.callCreateCampaignContract(params);

      return {
        campaignId: this.generateCampaignId(params),
        transactionHash: txHash,
        timestamp: Date.now(),
        totalCost: this.calculateFees().totalFee,
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Validate campaign parameters
   */
  private validateCampaignParams(params: CampaignParams): void {
    if (!params.title || params.title.trim().length === 0) {
      throw this.createError(ErrorCode.INVALID_INPUT, 'Campaign title is required');
    }

    if (!params.description || params.description.trim().length === 0) {
      throw this.createError(ErrorCode.INVALID_INPUT, 'Campaign description is required');
    }

    try {
      const budget = parseFloat(params.budget);
      if (budget <= 0) {
        throw this.createError(ErrorCode.INVALID_INPUT, 'Budget must be greater than 0');
      }
    } catch {
      throw this.createError(ErrorCode.INVALID_INPUT, 'Invalid budget amount');
    }

    if (params.duration < 3600 || params.duration > 31536000) {
      throw this.createError(ErrorCode.INVALID_INPUT, 'Duration must be between 1 hour and 1 year');
    }

    if (params.slippage < 0 || params.slippage > 100) {
      throw this.createError(ErrorCode.INVALID_INPUT, 'Slippage must be between 0% and 100%');
    }

    if (!params.creatorAddress || !params.creatorAddress.startsWith('G')) {
      throw this.createError(ErrorCode.INVALID_INPUT, 'Invalid creator address');
    }

    if (!params.tokenAddress || !params.tokenAddress.startsWith('C')) {
      throw this.createError(ErrorCode.INVALID_INPUT, 'Invalid token address');
    }
  }

  /**
   * Call contract to create campaign
   */
  private async callCreateCampaignContract(params: CampaignParams): Promise<string> {
    try {
      // This would call the actual Stellar contract
      // For now, returning a mock transaction hash
      // In production, this would use StellarService to invoke the contract
      return this.generateMockTransactionHash();
    } catch (error) {
      if (error instanceof Error) {
        const contractError = this.parseContractError(error.message);
        if (contractError) {
          throw this.createError(
            ErrorCode.CONTRACT_ERROR,
            contractError.userMessage,
            contractError.message
          );
        }
      }
      throw error;
    }
  }

  /**
   * Parse contract error response
   */
  private parseContractError(errorMessage: string): ContractError | null {
    // Try to extract error code from message
    const codeMatch = errorMessage.match(/error[:\s]+(\d+)/i);
    if (codeMatch) {
      const code = parseInt(codeMatch[1], 10);
      return CONTRACT_ERROR_MAP[code] || null;
    }
    return null;
  }

  /**
   * Generate campaign ID
   */
  private generateCampaignId(params: CampaignParams): string {
    const timestamp = Date.now();
    const hash = this.simpleHash(`${params.creatorAddress}${params.tokenAddress}${timestamp}`);
    return `campaign_${hash}`;
  }

  /**
   * Simple hash function for ID generation
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Generate mock transaction hash for testing
   */
  private generateMockTransactionHash(): string {
    return 'a'.repeat(64);
  }

  /**
   * Create error object
   */
  private createError(code: string, message: string, details?: string): AppError {
    return { code, message, details };
  }

  /**
   * Handle errors from contract calls
   */
  private handleError(error: any): AppError {
    if (error && typeof error === 'object' && 'code' in error) {
      return error as AppError;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('insufficient')) {
      return this.createError(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance for campaign');
    }

    if (message.includes('rejected')) {
      return this.createError(ErrorCode.WALLET_REJECTED, 'Transaction was rejected');
    }

    if (message.includes('timeout')) {
      return this.createError(ErrorCode.TIMEOUT_ERROR, 'Transaction confirmation timeout');
    }

    if (message.includes('network')) {
      return this.createError(ErrorCode.NETWORK_ERROR, 'Network error occurred');
    }

    return this.createError(ErrorCode.TRANSACTION_FAILED, 'Campaign creation failed', message);
  }
}
