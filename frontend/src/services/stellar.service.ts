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
import { FACTORY_METHODS } from '../contracts/factoryAbi';
import { mappers } from '../contracts/mappers';
import { WalletService } from './wallet';
import type { ProposalParams, VoteParams } from '../types/governance';
import type { OnChainBuybackCampaign } from '../types/campaign';
import { decodeSimulationError } from './stellarErrors';

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
  creatorAddress: string;
  feePayment: bigint;
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

  async createBuybackCampaign(params: {
    creatorAddress: string;
    tokenIndex: number;
    budget: bigint;
    startTime: number;
    endTime: number;
    minInterval: number;
    maxSlippageBps: number;
    sourceToken: string;
    targetToken: string;
  }): Promise<{ txHash: string; campaignId: string }> {
    if (!this.contractClient) {
      throw this.createError(ErrorCode.CONTRACT_ERROR, 'Contract client not initialized');
    }

    const walletService = new WalletService();
    const account = await this.server.getAccount(params.creatorAddress);

    const operation = this.contractClient.call(
      'create_buyback_campaign',
      nativeToScVal(params.creatorAddress, { type: 'address' }),
      nativeToScVal(params.tokenIndex, { type: 'u32' }),
      nativeToScVal(params.budget, { type: 'i128' }),
      nativeToScVal(params.startTime, { type: 'u64' }),
      nativeToScVal(params.endTime, { type: 'u64' }),
      nativeToScVal(params.minInterval, { type: 'u64' }),
      nativeToScVal(params.maxSlippageBps, { type: 'u32' }),
      nativeToScVal(params.sourceToken, { type: 'address' }),
      nativeToScVal(params.targetToken, { type: 'address' })
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
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;

    const response = await this.server.sendTransaction(signedTx);
    if (response.status === 'ERROR') {
      throw this.createError(ErrorCode.TRANSACTION_FAILED, 'Transaction submission failed');
    }

    const confirmed = await this.waitForTransaction(response.hash);
    const campaignId: string =
      confirmed.returnValue ? scValToNative(confirmed.returnValue).toString() : '0';

    return { txHash: response.hash, campaignId };
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
        FACTORY_METHODS.create_buyback_campaign,
        ...mappers.createBuybackCampaign({
          creator: executorAddress,
          token_index: campaignId,
          budget: BigInt(0),
          start_time: BigInt(0),
          end_time: BigInt(0),
          min_interval: BigInt(0),
          max_slippage_bps: 0,
          source_token: executorAddress,
          target_token: executorAddress,
        })
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

  async getBuybackCampaign(campaignId: number): Promise<OnChainBuybackCampaign> {
    if (!this.contractClient) {
      throw this.createError(
        ErrorCode.CONTRACT_ERROR,
        'Contract client not initialized'
      );
    }

    try {
      const operation = this.contractClient.call(
        'get_buyback_campaign',
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
        const raw = scValToNative(simulated.result!.retval) as OnChainBuybackCampaign;
        return raw;
      }

      throw new Error('Simulation failed');
    } catch (error) {
      throw this.createError(
        ErrorCode.CONTRACT_ERROR,
        'Failed to get buyback campaign',
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
        .addOperation(this.contractClient.call(FACTORY_METHODS.is_paused, ...mappers.isPaused()))
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

  // ── Admin / Treasury read methods ────────────────────────────────────────────

  /**
   * Simulate a no-arg contract read and return the native JS value.
   * Uses a throw-away keypair — no funded account required.
   */
  private async simulateRead(method: string, args: import('@stellar/stellar-sdk').xdr.ScVal[] = []): Promise<unknown> {
    if (!this.contractClient) {
      throw this.createError(ErrorCode.CONTRACT_ERROR, 'Contract client not initialized');
    }
    const dummyAccount = new Account(Keypair.random().publicKey(), '0');
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contractClient.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (!Soroban.Api.isSimulationSuccess(sim) || !sim.result) {
      throw this.createError(ErrorCode.SIMULATION_FAILED, `Simulation failed for ${method}`);
    }
    return scValToNative(sim.result.retval);
  }

  /** Read current admin, proposed admin, treasury, fees, and pause state. */
  async getAdminState(): Promise<import('../types/admin').FactoryAdminState> {
    const raw = await this.simulateRead(FACTORY_METHODS.get_state) as Record<string, unknown>;
    return {
      admin: String(raw['admin'] ?? ''),
      proposedAdmin: raw['proposed_admin'] ? String(raw['proposed_admin']) : null,
      treasury: String(raw['treasury'] ?? ''),
      baseFee: BigInt(String(raw['base_fee'] ?? '0')),
      metadataFee: BigInt(String(raw['metadata_fee'] ?? '0')),
      paused: Boolean(raw['paused']),
    };
  }

  /** Read treasury policy: daily cap, withdrawn today, remaining capacity, allowlist. */
  async getTreasuryPolicy(): Promise<import('../types/admin').TreasuryPolicy> {
    const [rawPolicy, remaining] = await Promise.all([
      this.simulateRead(FACTORY_METHODS.get_treasury_policy) as Promise<Record<string, unknown>>,
      this.simulateRead(FACTORY_METHODS.get_remaining_capacity).catch(() => BigInt(0)),
    ]);
    return {
      dailyCap: BigInt(String(rawPolicy['daily_cap'] ?? '0')),
      withdrawnToday: BigInt(String(rawPolicy['withdrawn_today'] ?? '0')),
      remainingCapacity: BigInt(String(remaining ?? '0')),
      allowedRecipients: Array.isArray(rawPolicy['allowed_recipients'])
        ? (rawPolicy['allowed_recipients'] as unknown[]).map(String)
        : [],
    };
  }

  /** Read timelock configuration (min/max delay). */
  async getTimelockConfig(): Promise<import('../types/admin').TimelockConfig> {
    const raw = await this.simulateRead(FACTORY_METHODS.get_timelock_config) as Record<string, unknown>;
    return {
      minDelay: Number(raw['min_delay'] ?? 0),
      maxDelay: Number(raw['max_delay'] ?? 0),
    };
  }

  /** Read any pending scheduled change, or null if none. */
  async getPendingChange(): Promise<import('../types/admin').PendingChange | null> {
    try {
      const raw = await this.simulateRead(FACTORY_METHODS.get_pending_change) as Record<string, unknown> | null;
      if (!raw) return null;
      return {
        changeType: String(raw['change_type'] ?? 'unknown'),
        executeAfter: Number(raw['execute_after'] ?? 0),
        description: String(raw['description'] ?? ''),
      };
    } catch {
      return null;
    }
  }

  async fundTestAccount(publicKey: string): Promise<void> {
    if (this.network !== 'testnet') {
      throw new Error('fundTestAccount is only available on testnet');
    }
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

  /**
   * Simulate a transaction before wallet signing.
   * Throws a user-friendly AppError if simulation fails, so the wallet prompt is never shown.
   */
  private async simulateBeforeSigning(tx: Transaction): Promise<void> {
    const sim = await this.server.simulateTransaction(tx);
    if (Soroban.Api.isSimulationError(sim)) {
      const decoded = decodeSimulationError(sim);
      const err: AppError = {
        code: decoded.code,
        message: decoded.userMessage,
        details: decoded.retrySuggestion,
      };
      // Attach debug detail without leaking it into the user-facing message
      (err as any).debugDetail = decoded.debugDetail;
      throw err;
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

  /**
   * Build the ScVal arguments for `create_token` in the exact order the contract expects:
   * create_token(creator, name, symbol, decimals, initial_supply, metadata_uri, fee_payment)
   */
  private buildCreateTokenArgs(creatorAddress: string, params: TokenDeploymentParams, feePayment: bigint) {
    const args = [
      nativeToScVal(creatorAddress, { type: 'address' }),
      nativeToScVal(params.name, { type: 'string' }),
      nativeToScVal(params.symbol, { type: 'string' }),
      nativeToScVal(params.decimals, { type: 'u32' }),
      nativeToScVal(BigInt(params.initialSupply), { type: 'i128' }),
      params.metadataUri
        ? nativeToScVal(params.metadataUri, { type: 'string' })
        : nativeToScVal(null, { type: 'option' }),
      nativeToScVal(feePayment, { type: 'i128' }),
    ];
    return args;
  }

  async deployToken(
    params: TokenDeploymentParams
  ): Promise<TokenDeploymentResult> {
    try {
      const { creatorAddress, feePayment } = params;
      const sourceAccount = await this.server.getAccount(creatorAddress);
      const contract = new Contract(STELLAR_CONFIG.factoryContractId);

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            FACTORY_METHODS.create_tokens,
            ...mappers.createTokens({
              creator: account.publicKey,
              tokens: [{
                name: params.name,
                symbol: params.symbol,
                decimals: params.decimals,
                initial_supply: BigInt(params.initialSupply),
                ...(params.metadataUri ? { metadata_uri: params.metadataUri } : {}),
              }],
              total_fee_payment: BigInt(70_000_000),
            })
          )
        )
        .setTimeout(180)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      await this.simulateBeforeSigning(prepared as Transaction);
      const signedXdr = await this.signWithWallet(prepared.toXDR());
      const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;

      const response = await this.server.sendTransaction(signedTx);
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

  /** Read base_fee and metadata_fee from the factory contract via simulation. Returns values in XLM. */
  async getContractFees(): Promise<{ baseFee: number; metadataFee: number }> {
    const contract = new Contract(STELLAR_CONFIG.factoryContractId);
    // Use a throw-away keypair as source — simulation doesn't require a funded account
    const dummyKeypair = Keypair.random();
    const dummyAccount = new Account(dummyKeypair.publicKey(), '0');

    const simulate = async (method: string): Promise<number> => {
      const tx = new TransactionBuilder(dummyAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call(method))
        .setTimeout(30)
        .build();
      const result = await this.server.simulateTransaction(tx);
      if (Soroban.Api.isSimulationSuccess(result) && result.result) {
        const stroops = Number(scValToNative(result.result.retval));
        return stroops / 10_000_000; // convert stroops → XLM
      }
      throw new Error(`Failed to read ${method} from contract`);
    };

    const [baseFee, metadataFee] = await Promise.all([
      simulate('get_base_fee'),
      simulate('get_metadata_fee'),
    ]);
    return { baseFee, metadataFee };
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

  /** Read the metadata URI stored on-chain for a token, then fetch the JSON from IPFS. */
  async getTokenMetadata(tokenAddress: string): Promise<import('../types').TokenMetadata | null> {
    try {
      const contract = new Contract(tokenAddress);
      const dummyAccount = new Account(Keypair.random().publicKey(), '0');
      const tx = new TransactionBuilder(dummyAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call('get_metadata'))
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (!Soroban.Api.isSimulationSuccess(sim) || !sim.result) return null;

      const uri: string = scValToNative(sim.result.retval);
      if (!uri || !uri.startsWith('ipfs://')) return null;

      const { IPFSService } = await import('./IPFSService');
      return new IPFSService().getMetadata(uri);
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
      
      // token_index is resolved server-side via tokenAddress; use 0 as placeholder
      // when a full registry lookup is available, replace with actual index.
      const account = await this.server.getAccount(from);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            FACTORY_METHODS.burn,
            ...mappers.burn({ caller: from, token_index: 0, amount: burnAmount })
          )
        )
        .setTimeout(180)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      await this.simulateBeforeSigning(prepared as Transaction);
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
    const { proposer, type, payload, startTime, endTime, eta } = params;
    try {
      const account = await this.server.getAccount(proposer);
      const contract = this.contractClient || new Contract(STELLAR_CONFIG.factoryContractId);
      
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            FACTORY_METHODS.create_proposal,
            ...mappers.createProposal({
              proposer,
              action_type: type,
              payload,
              start_time: startTime,
              end_time: endTime,
              eta,
            })
          )
        )
        .setTimeout(180)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      await this.simulateBeforeSigning(prepared as Transaction);
      const signedXdr = await this.signWithWallet(prepared.toXDR());
      const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
      
      const response = await this.server.sendTransaction(signedTx);
      return response.hash;
    } catch (error) {
      throw this.handleError(error, 'propose');
    }
  }

  async vote(params: VoteParams): Promise<string> {
    const { voter, proposalId, support } = params;
    try {
      const account = await this.server.getAccount(voter);
      const contract = this.contractClient || new Contract(STELLAR_CONFIG.factoryContractId);
      
      // VoteChoice: For=0, Against=1, Abstain=2
      const choice = support ? 0 : 1;

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            FACTORY_METHODS.vote_proposal,
            ...mappers.voteProposal({
              voter,
              proposal_id: BigInt(proposalId),
              support: choice,
            })
          )
        )
        .setTimeout(180)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      await this.simulateBeforeSigning(prepared as Transaction);
      const signedXdr = await this.signWithWallet(prepared.toXDR());
      const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
      
      const response = await this.server.sendTransaction(signedTx);
      return response.hash;
    } catch (error) {
      throw this.handleError(error, 'vote');
    }
  }

  async finalizeProposal(voter: string, proposalId: number): Promise<string> {
    return this.invokeProposalMethod(voter, proposalId, FACTORY_METHODS.finalize_proposal);
  }

  async queueProposal(voter: string, proposalId: number): Promise<string> {
    return this.invokeProposalMethod(voter, proposalId, FACTORY_METHODS.queue_proposal);
  }

  async executeProposal(voter: string, proposalId: number): Promise<string> {
    return this.invokeProposalMethod(voter, proposalId, FACTORY_METHODS.execute_proposal);
  }

  private async invokeProposalMethod(
    caller: string,
    proposalId: number,
    method: string
  ): Promise<string> {
    try {
      const account = await this.server.getAccount(caller);
      const contract = this.contractClient || new Contract(STELLAR_CONFIG.factoryContractId);
      
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(method, ...mappers.proposalId(BigInt(proposalId)))
        )
        .setTimeout(180)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      const signedXdr = await this.signWithWallet(prepared.toXDR());
      const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
      
      const response = await this.server.sendTransaction(signedTx);
      return response.hash;
    } catch (error) {
      throw this.handleError(error, method);
    }
  }

  async getProposal(proposalId: number): Promise<any> {
    return this.simulateRead(FACTORY_METHODS.get_proposal, mappers.proposalId(BigInt(proposalId)));
  }

  async getVoteCounts(proposalId: number): Promise<{ for: bigint; against: bigint; abstain: bigint }> {
    const raw = await this.simulateRead(FACTORY_METHODS.get_vote_counts, mappers.proposalId(BigInt(proposalId))) as [bigint, bigint, bigint];
    return {
      for: raw[0],
      against: raw[1],
      abstain: raw[2],
    };
  }

  private handleError(error: any, action: string): AppError {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('rejected')) {
      return this.createError(ErrorCode.WALLET_REJECTED, 'Transaction rejected by wallet');
    }
    return this.createError(ErrorCode.TRANSACTION_FAILED, `${action} failed`, errorMsg);
  }
}
