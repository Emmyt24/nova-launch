import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc as Soroban,
  Address,
  Transaction,
  Keypair,
  Account,
} from '@stellar/stellar-sdk';
import { STELLAR_CONFIG, getNetworkConfig } from '../config/stellar';
import type { 
  AppError, 
  BurnTokenParams, 
  BurnResult,
} from '../types';
import { ErrorCode } from '../types';

import { WalletService } from './wallet';
import type { ProposalParams, VoteParams } from '../types/governance';

export interface TransactionDetails {
  hash: string;
  status: 'pending' | 'success' | 'failed';
  timestamp: number;
  fee: string;
}

export interface TestAccount {
  publicKey: string;
  secretKey: string;
}

export interface TokenDeploymentParams {
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: string;
  metadataUri?: string;
}

export interface TokenDeploymentResult {
  tokenAddress: string;
  transactionHash: string;
  creatorBalance: string;
}

export class StellarService {
  private network: 'testnet' | 'mainnet';
  private server: Soroban.Server;
  private horizonUrl: string;
  private networkPassphrase: string;
  private contractClient: Contract | null = null;

  constructor(network: 'testnet' | 'mainnet' = 'testnet') {
    this.network = network;
    const config = getNetworkConfig(network);
    
    this.server = new Soroban.Server(config.sorobanRpcUrl);
    this.horizonUrl = config.horizonUrl;
    this.networkPassphrase = config.networkPassphrase;
    
    this.initializeContractClient();
  }

  getNetwork(): 'testnet' | 'mainnet' {
    return this.network;
  }

  private initializeContractClient(): void {
    const contractId = STELLAR_CONFIG.factoryContractId;
    if (!contractId) {
      console.warn('Factory contract ID not configured');
      return;
    }

    try {
      this.contractClient = new Contract(contractId);
    } catch (error) {
      throw this.createError(
        ErrorCode.CONTRACT_ERROR,
        'Failed to initialize contract client',
        error instanceof Error ? error.message : undefined
      );
    }
  }

  private createError(code: string, message: string, details?: string): AppError {
    return { code, message, details };
  }

  async createTestAccount(): Promise<TestAccount> {
    const keypair = Keypair.random();
    return {
      publicKey: keypair.publicKey(),
      secretKey: keypair.secret(),
    };
  }

  async executeBuybackStep(
    campaignId: number,
    executorAddress: string
  ): Promise<{ txHash: string }> {
    if (!this.contractClient) {
      throw this.createError(
        ErrorCode.CONTRACT_ERROR,
        'Contract client not initialized'
      );
    }

    try {
      const walletService = new WalletService();
      const account = await this.server.getAccount(executorAddress);

      const operation = this.contractClient.call(
        'execute_buyback_step',
        nativeToScVal(executorAddress, { type: 'address' }),
        nativeToScVal(campaignId, { type: 'u64' })
      );

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(180)
        .build();

      const preparedTx = await this.server.prepareTransaction(transaction);
      const signedXdr = await walletService.signTransaction(preparedTx.toXDR());
      const signedTx = TransactionBuilder.fromXDR(
        signedXdr,
        this.networkPassphrase
      );

      const response = await this.server.sendTransaction(signedTx);

      if (response.status === 'ERROR') {
        throw new Error('Transaction failed');
      }

      let txResponse = await this.server.getTransaction(response.hash);
      while (txResponse.status === 'NOT_FOUND') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        txResponse = await this.server.getTransaction(response.hash);
      }

      if (txResponse.status === 'FAILED') {
        throw new Error('Transaction failed on network');
      }

      return { txHash: response.hash };
    } catch (error) {
      throw this.createError(
        ErrorCode.TRANSACTION_FAILED,
        'Failed to execute buyback step',
        error instanceof Error ? error.message : undefined
      );
    }
  }

  async getCampaign(campaignId: number): Promise<any> {
    if (!this.contractClient) {
      throw this.createError(
        ErrorCode.CONTRACT_ERROR,
        'Contract client not initialized'
      );
    }

    try {
      const operation = this.contractClient.call(
        'get_campaign',
        nativeToScVal(campaignId, { type: 'u64' })
      );

      const account = await this.server.getAccount(Keypair.random().publicKey());
      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(180)
        .build();

      const simulated = await this.server.simulateTransaction(transaction);

      if (Soroban.Api.isSimulationSuccess(simulated)) {
        return scValToNative(simulated.result!.retval);
      }

      throw new Error('Simulation failed');
    } catch (error) {
      throw this.createError(
        ErrorCode.CONTRACT_ERROR,
        'Failed to get campaign',
        error instanceof Error ? error.message : undefined
      );
    }
  }

  /**
   * Check if factory contract is paused
   */
  async isPaused(): Promise<boolean> {
    if (!this.contractClient) {
      throw this.createError(
        ErrorCode.CONTRACT_ERROR,
        'Contract client not initialized'
      );
    }

    try {
      const dummyKeypair = Keypair.random();
      const account = await this.server.getAccount(dummyKeypair.publicKey()).catch(() => {
        // Create minimal account object if account doesn't exist
        return {
          accountId: () => dummyKeypair.publicKey(),
          sequenceNumber: () => '0',
        } as any;
      });

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contractClient.call('is_paused'))
        .setTimeout(30)
        .build();

      const simulated = await this.server.simulateTransaction(tx);

      if (Soroban.Api.isSimulationSuccess(simulated) && simulated.result) {
        return scValToNative(simulated.result.retval);
      }

      return false;
    } catch (error) {
      console.error('Failed to check pause state:', error);
      // Default to not paused on error to avoid blocking users unnecessarily
      return false;
    }
  }
}

  async fundTestAccount(publicKey: string): Promise<void> {
    try {
      const response = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
      if (!response.ok) {
        throw new Error('Friendbot funding failed');
      }
    } catch (error) {
      throw this.createError(
        ErrorCode.NETWORK_ERROR,
        'Failed to fund test account',
        error instanceof Error ? error.message : undefined
      );
    }
  }

  async getTransaction(hash: string): Promise<TransactionDetails> {
    try {
      const response = await fetch(`${this.horizonUrl}/transactions/${hash}`);
      if (response.status === 404) {
        return {
          hash,
          status: 'pending',
          timestamp: Date.now(),
          fee: '0',
        };
      }
      
      const tx = await response.json();
      return {
        hash,
        status: tx.successful ? 'success' : 'failed',
        timestamp: new Date(tx.created_at).getTime(),
        fee: tx.fee_charged || '0',
      };
    } catch (error) {
      throw this.createError(
        ErrorCode.NETWORK_ERROR,
        'Failed to fetch transaction',
        error instanceof Error ? error.message : undefined
      );
    }
  }

  private async signWithWallet(xdr: string): Promise<string> {
    const signedXdr = await WalletService.signTransaction(xdr, this.networkPassphrase);
    if (!signedXdr) {
      throw this.createError(ErrorCode.WALLET_REJECTED, 'Transaction rejected by wallet');
    }
    return signedXdr;
  }

  private async waitForTransaction(hash: string, timeout = 30000): Promise<any> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const tx = await this.server.getTransaction(hash);
        if (tx.status === Soroban.Api.GetTransactionStatus.SUCCESS) {
          return tx;
        }
        if (tx.status === Soroban.Api.GetTransactionStatus.FAILED) {
          throw new Error('Transaction failed');
        }
      } catch (error) {
        if (error instanceof Error && !error.message.includes('not found')) {
          throw error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw this.createError(ErrorCode.TIMEOUT_ERROR, 'Transaction confirmation timeout');
  }

  async deployToken(
    account: TestAccount,
    params: TokenDeploymentParams
  ): Promise<TokenDeploymentResult> {
    try {
      const sourceAccount = await this.server.getAccount(account.publicKey);
      const contract = new Contract(STELLAR_CONFIG.factoryContractId);
      
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'deploy_token',
            nativeToScVal(params.name, { type: 'string' }),
            nativeToScVal(params.symbol, { type: 'string' }),
            nativeToScVal(params.decimals, { type: 'u32' }),
            nativeToScVal(params.initialSupply, { type: 'i128' }),
            nativeToScVal(account.publicKey, { type: 'address' })
          )
        )
        .setTimeout(180)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const keypair = Keypair.fromSecret(account.secretKey);
      prepared.sign(keypair);
      
      const response = await this.server.sendTransaction(prepared);
      const result = await this.waitForTransaction(response.hash);
      
      const tokenAddress = result.returnValue ? scValToNative(result.returnValue) : '';

      return {
        tokenAddress,
        transactionHash: response.hash,
        creatorBalance: params.initialSupply,
      };
    } catch (error) {
      throw this.handleError(error, 'deploy');
    }
  }

  async getTokenBalance(tokenAddress: string, accountAddress: string): Promise<string> {
    try {
      const contract = new Contract(tokenAddress);
      // Simulate requires an Account instance with sequence number
      const accountData = await this.server.getAccount(accountAddress);
      const account = new Account(accountData.accountId(), accountData.sequenceNumber());
      
      const tx = new TransactionBuilder(account, { 
        fee: BASE_FEE, 
        networkPassphrase: this.networkPassphrase 
      })
        .addOperation(contract.call('balance', nativeToScVal(accountAddress, { type: 'address' })))
        .setTimeout(30)
        .build();
        
      const result = await this.server.simulateTransaction(tx);
      if (Soroban.Api.isSimulationSuccess(result) && result.result) {
        return scValToNative(result.result.retval).toString();
      }
      return '0';
    } catch {
      return '0';
    }
  }

  async verifyTokenExists(tokenAddress: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.horizonUrl}/accounts/${tokenAddress}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async getTokenMetadata(tokenAddress: string): Promise<string | null> {
    try {
      // Placeholder: retrieve metadata from contract
      return null;
    } catch {
      return null;
    }
  }

  async burnTokens(params: BurnTokenParams): Promise<BurnResult> {
    const { tokenAddress, from, amount } = params;
    try {
      Address.fromString(tokenAddress);
      Address.fromString(from);
      
      const burnAmount = BigInt(Math.floor(parseFloat(amount) * 1e7));
      const contract = this.contractClient || new Contract(STELLAR_CONFIG.factoryContractId);
      
      const account = await this.server.getAccount(from);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'burn',
            nativeToScVal(tokenAddress, { type: 'address' }),
            nativeToScVal(from, { type: 'address' }),
            nativeToScVal(burnAmount, { type: 'i128' })
          )
        )
        .setTimeout(180)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await this.signWithWallet(prepared.toXDR());
      const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
      
      const response = await this.server.sendTransaction(signedTx);
      await this.waitForTransaction(response.hash);
      
      return {
        txHash: response.hash,
        burnedAmount: amount,
        newBalance: '0', 
        newSupply: '0',
      };
    } catch (error) {
      throw this.handleError(error, 'burn');
    }
  }

  async propose(params: ProposalParams): Promise<string> {
    const { proposer, title, description, type, action } = params;
    try {
      const account = await this.server.getAccount(proposer);
      const contract = this.contractClient || new Contract(STELLAR_CONFIG.factoryContractId);
      
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'propose',
            nativeToScVal(proposer, { type: 'address' }),
            nativeToScVal(title, { type: 'string' }),
            nativeToScVal(description, { type: 'string' }),
            nativeToScVal(type, { type: 'string' }),
            nativeToScVal(action.contractId, { type: 'address' }),
            nativeToScVal(action.functionName, { type: 'string' }),
            nativeToScVal(action.args, { type: 'vec' })
          )
        )
        .setTimeout(180)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await this.signWithWallet(prepared.toXDR());
      const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
      
      const response = await this.server.sendTransaction(signedTx);
      return response.hash;
    } catch (error) {
      throw this.handleError(error, 'propose');
    }
  }

  async vote(params: VoteParams): Promise<string> {
    const { voter, proposalId, support, reason } = params;
    try {
      const account = await this.server.getAccount(voter);
      const contract = this.contractClient || new Contract(STELLAR_CONFIG.factoryContractId);
      
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'vote',
            nativeToScVal(voter, { type: 'address' }),
            nativeToScVal(proposalId, { type: 'u32' }),
            nativeToScVal(support, { type: 'bool' }),
            nativeToScVal(reason || "", { type: 'string' })
          )
        )
        .setTimeout(180)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await this.signWithWallet(prepared.toXDR());
      const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
      
      const response = await this.server.sendTransaction(signedTx);
      return response.hash;
    } catch (error) {
      throw this.handleError(error, 'vote');
    }
  }

  private handleError(error: any, action: string): AppError {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('rejected')) {
      return this.createError(ErrorCode.WALLET_REJECTED, 'Transaction rejected by wallet');
    }
    return this.createError(ErrorCode.TRANSACTION_FAILED, `${action} failed`, errorMsg);
  }
}
