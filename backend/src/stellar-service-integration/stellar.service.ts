/**
 * StellarService — transaction / contract integration layer
 *   (backend/src/stellar-service-integration/)
 *
 * PURPOSE
 * -------
 * Full-featured Stellar client responsible for all write operations and
 * contract interactions: deploying tokens via the factory contract, minting,
 * monitoring transaction status, and reading on-chain state via Soroban RPC.
 * It owns the retry logic, circuit breaker, rate limiter, and sequence-number
 * cache needed for reliable contract invocations.
 *
 * HOW IT DIFFERS FROM THE OTHER StellarService
 * ---------------------------------------------
 * There is a second file with the identical class name located at:
 *   backend/src/token-info/stellar.service.ts
 *
 * That service is the *read-only* layer: it fetches token metadata, burn
 * statistics, and trading volume from the public Horizon REST API.  It has no
 * retry stack and is injected exclusively into the tokens info module.
 *
 * This file (stellar-service-integration) vs. that file (token-info):
 *
 *   | Concern                | stellar-service-integration (this file)   | token-info              |
 *   |------------------------|-------------------------------------------|-------------------------|
 *   | Storage tier used      | read + write (Soroban RPC)                | read-only               |
 *   | Primary client         | @stellar/stellar-sdk (Horizon + Soroban)  | Horizon HTTP only       |
 *   | Retry / circuit-breaker| RateLimiter + CircuitBreaker              | none (simple HTTP)      |
 *   | Injected into          | StellarModule (app-wide)                  | TokensModule            |
 *
 * If you are looking for the lightweight service that only reads asset/trade
 * data from Horizon, open:
 *   backend/src/token-info/stellar.service.ts
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  StellarConfig,
  DEFAULT_STELLAR_CONFIG,
  TokenInfo,
  BurnEvent,
  FactoryState,
  ParsedContractEvent,
  TransactionDetails,
  TransactionStatus,
  MonitorTransactionResult,
} from "./stellar.config";
import {
  StellarNetworkException,
  StellarContractException,
  StellarNotFoundException,
  StellarParseException,
  StellarTimeoutException,
  StellarTransactionFailedException,
} from "./stellar.exceptions";
import { 
  RateLimiter, 
  BACKGROUND_RETRY_CONFIG,
  calculateBackoffDelay,
  isRetryableError,
  sleep
} from "./rate-limiter";
import { CircuitBreaker } from "../lib/circuitBreaker";
import {
  assertValidAddress,
  isValidAddress,
} from "./stellar.utils";
import { SequenceNumberCache } from "./sequence-number-cache";
import { CacheStellarRead } from "./stellar-cache.decorator";

@Injectable()
export class StellarService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StellarService.name);
  private readonly config: StellarConfig;
  private horizon: StellarSdk.Horizon.Server;
  private soroban: StellarSdk.rpc.Server;
  private readonly rateLimiter: RateLimiter;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly sequenceCache: SequenceNumberCache;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      network:
        this.configService.get<"testnet" | "mainnet">("STELLAR_NETWORK") ??
        DEFAULT_STELLAR_CONFIG.network,
      horizonUrl:
        this.configService.get<string>("STELLAR_HORIZON_URL") ??
        DEFAULT_STELLAR_CONFIG.horizonUrl,
      sorobanRpcUrl:
        this.configService.get<string>("STELLAR_SOROBAN_RPC_URL") ??
        DEFAULT_STELLAR_CONFIG.sorobanRpcUrl,
      factoryContractId:
        this.configService.get<string>("STELLAR_FACTORY_CONTRACT_ID") ??
        DEFAULT_STELLAR_CONFIG.factoryContractId,
      requestTimeout:
        this.configService.get<number>("STELLAR_REQUEST_TIMEOUT") ??
        DEFAULT_STELLAR_CONFIG.requestTimeout,
      retry: {
        maxAttempts:
          this.configService.get<number>("STELLAR_RETRY_MAX_ATTEMPTS") ??
          DEFAULT_STELLAR_CONFIG.retry.maxAttempts,
        initialDelay:
          this.configService.get<number>("STELLAR_RETRY_INITIAL_DELAY") ??
          DEFAULT_STELLAR_CONFIG.retry.initialDelay,
        maxDelay:
          this.configService.get<number>("STELLAR_RETRY_MAX_DELAY") ??
          DEFAULT_STELLAR_CONFIG.retry.maxDelay,
        backoffFactor:
          this.configService.get<number>("STELLAR_RETRY_BACKOFF_FACTOR") ??
          DEFAULT_STELLAR_CONFIG.retry.backoffFactor,
      },
      rateLimit: {
        maxRequests:
          this.configService.get<number>("STELLAR_RATE_LIMIT_MAX") ??
          DEFAULT_STELLAR_CONFIG.rateLimit.maxRequests,
        windowMs:
          this.configService.get<number>("STELLAR_RATE_LIMIT_WINDOW_MS") ??
          DEFAULT_STELLAR_CONFIG.rateLimit.windowMs,
      },
      circuitBreaker: {
        failureThreshold:
          this.configService.get<number>("STELLAR_CIRCUIT_BREAKER_FAILURE_THRESHOLD") ??
          DEFAULT_STELLAR_CONFIG.circuitBreaker.failureThreshold,
        successThreshold:
          this.configService.get<number>("STELLAR_CIRCUIT_BREAKER_SUCCESS_THRESHOLD") ??
          DEFAULT_STELLAR_CONFIG.circuitBreaker.successThreshold,
        timeoutMs:
          this.configService.get<number>("STELLAR_CIRCUIT_BREAKER_TIMEOUT_MS") ??
          DEFAULT_STELLAR_CONFIG.circuitBreaker.timeoutMs,
      },
    };

    this.rateLimiter = new RateLimiter(
      this.config.rateLimit.maxRequests,
      this.config.rateLimit.windowMs
    );

    this.circuitBreaker = new CircuitBreaker(this.config.circuitBreaker);
    
    // Initialize sequence number cache (5 min TTL)
    this.sequenceCache = new SequenceNumberCache(300000);
  }

  onModuleInit(): void {
    this.horizon = new StellarSdk.Horizon.Server(this.config.horizonUrl, {
      allowHttp: this.config.network === "testnet",
    });

    this.soroban = new StellarSdk.rpc.Server(this.config.sorobanRpcUrl, {
      allowHttp: this.config.network === "testnet",
    });

    this.logger.log(
      `StellarService initialized on ${this.config.network}. ` +
        `Horizon: ${this.config.horizonUrl}, Soroban: ${this.config.sorobanRpcUrl}`
    );

    // Invalidate cached sequence numbers as soon as a ledger closes rather
    // than relying solely on the TTL fallback.
    try {
      this.sequenceCache.startLedgerSubscription(this.horizon as any);
    } catch (error) {
      this.logger.error(
        "Failed to start ledger-close subscription; falling back to TTL-only sequence cache invalidation",
        error as Error
      );
    }
  }

  onModuleDestroy(): void {
    this.sequenceCache.stopLedgerSubscription();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get account with sequence number management.
   * Uses cached sequence if available, fetches from network otherwise.
   * 
   * @param accountId - Account public key
   * @returns Account object with current sequence number
   */
  async getAccountWithSequence(accountId: string): Promise<StellarSdk.Horizon.AccountResponse> {
    assertValidAddress(accountId);
    
    return this.sequenceCache.executeWithSequenceManagement(
      accountId,
      async () => {
        this.rateLimiter.checkLimit();
        return await this.horizon.loadAccount(accountId);
      },
      async (account) => account
    );
  }

  /**
   * Execute a transaction with automatic sequence number management.
   * Handles locking, caching, incrementing, and refresh on mismatch.
   * 
   * @param accountId - Source account public key
   * @param buildTransaction - Function that builds and signs the transaction
   * @returns Transaction submission result
   */
  async executeTransaction<T = any>(
    accountId: string,
    buildTransaction: (account: StellarSdk.Horizon.AccountResponse) => Promise<StellarSdk.Transaction>
  ): Promise<{ hash: string; result: T }> {
    assertValidAddress(accountId);

    return this.sequenceCache.executeWithSequenceManagement(
      accountId,
      async () => {
        this.rateLimiter.checkLimit();
        return await this.horizon.loadAccount(accountId);
      },
      async (account) => {
        const transaction = await buildTransaction(account);
        const response = await this.horizon.submitTransaction(transaction);
        
        return {
          hash: response.hash,
          result: response as any,
        };
      }
    );
  }

  /**
   * Validates a Stellar address (account or contract).
   */
  validateAddress(address: string): boolean {
    this.logger.debug(`Validating address: ${address}`);
    return isValidAddress(address);
  }

  /**
   * Fetches token details from a Soroban token contract.
   * Results are cached for the default TTL to reduce RPC load.
   * Pass `fresh: true` in the decorator options at the call site to bypass.
   */
  @CacheStellarRead('tokenInfo')
  async getTokenInfo(tokenAddress: string): Promise<TokenInfo> {
    assertValidAddress(tokenAddress);
    this.logger.log(`Fetching token info for: ${tokenAddress}`);

    return this.withRetry(async () => {
      this.rateLimiter.checkLimit();
      try {
        const [name, symbol, decimals, totalSupply, admin] = await Promise.all([
          this.callContract<string>(tokenAddress, "name", []),
          this.callContract<string>(tokenAddress, "symbol", []),
          this.callContract<number>(tokenAddress, "decimals", []),
          this.callContract<string>(tokenAddress, "total_supply", []),
          this.callContract<string>(tokenAddress, "admin", []),
        ]);

        return {
          address: tokenAddress,
          name,
          symbol,
          decimals,
          totalSupply,
          admin,
        };
      } catch (error) {
        this.logger.error(
          `Failed to fetch token info for ${tokenAddress}`,
          error
        );
        throw new StellarContractException(
          `Failed to fetch token info for ${tokenAddress}`,
          error
        );
      }
    }, "getTokenInfo");
  }

  /**
   * Retrieves burn events for a given token address.
   */
  async getBurnHistory(tokenAddress: string): Promise<BurnEvent[]> {
    assertValidAddress(tokenAddress);
    this.logger.log(`Fetching burn history for: ${tokenAddress}`);

    return this.withRetry(async () => {
      this.rateLimiter.checkLimit();
      try {
        const response = await this.soroban.getEvents({
          startLedger: 1,
          filters: [
            {
              type: "contract",
              contractIds: [tokenAddress],
              topics: [["burn"]],
            },
          ],
        });

        return response.events.map((event) =>
          this.parseBurnEvent(event, tokenAddress)
        );
      } catch (error) {
        this.logger.error(
          `Failed to fetch burn history for ${tokenAddress}`,
          error
        );
        throw new StellarContractException(
          `Failed to fetch burn history for ${tokenAddress}`,
          error
        );
      }
    }, "getBurnHistory");
  }

  /**
   * Gets the factory contract state.
   * Results are cached for the default TTL to reduce RPC load.
   */
  @CacheStellarRead('factoryState')
  async getFactoryState(): Promise<FactoryState> {
    if (!this.config.factoryContractId) {
      throw new StellarContractException(
        "Factory contract ID is not configured"
      );
    }

    this.logger.log(`Fetching factory state: ${this.config.factoryContractId}`);

    return this.withRetry(async () => {
      this.rateLimiter.checkLimit();
      try {
        const [admin, totalTokens, tokens, isPaused] = await Promise.all([
          this.callContract<string>(
            this.config.factoryContractId,
            "get_admin",
            []
          ),
          this.callContract<number>(
            this.config.factoryContractId,
            "get_token_count",
            []
          ),
          this.callContract<string[]>(
            this.config.factoryContractId,
            "get_tokens",
            []
          ),
          this.callContract<boolean>(
            this.config.factoryContractId,
            "is_paused",
            []
          ),
        ]);

        return {
          contractId: this.config.factoryContractId,
          admin,
          totalTokens,
          tokens,
          isPaused,
        };
      } catch (error) {
        this.logger.error("Failed to fetch factory state", error);
        throw new StellarContractException(
          "Failed to fetch factory state",
          error
        );
      }
    }, "getFactoryState");
  }

  /**
   * Parses a raw Soroban contract event into a structured format.
   */
  parseContractEvent(
    event: StellarSdk.rpc.Api.EventResponse
  ): ParsedContractEvent {
    try {
      const topics = event.topic.map((t) => StellarSdk.scValToNative(t));
      const data = StellarSdk.scValToNative(event.value);

      return {
        type: topics[0] as string,
        contractId: event.contractId,
        topics: topics.slice(1),
        data,
        ledger: event.ledger,
        txHash: event.txHash,
        timestamp: new Date(event.ledgerClosedAt).toISOString(),
      };
    } catch (error) {
      this.logger.error("Failed to parse contract event", error);
      throw new StellarParseException("Failed to parse contract event", error);
    }
  }

  /**
   * Retrieves full transaction details from Horizon.
   * Results are cached for the default TTL — transactions are immutable once
   * confirmed so this is safe for successful lookups.
   */
  @CacheStellarRead('transaction')
  async getTransaction(txHash: string): Promise<TransactionDetails> {
    if (!txHash || typeof txHash !== "string") {
      throw new StellarNotFoundException("Transaction", txHash);
    }

    this.logger.log(`Fetching transaction: ${txHash}`);

    return this.withRetry(async () => {
      this.rateLimiter.checkLimit();
      try {
        const tx = await this.horizon.transactions().transaction(txHash).call();

        return {
          hash: tx.hash,
          ledger: tx.ledger_attr,
          createdAt: tx.created_at,
          sourceAccount: tx.source_account,
          fee: tx.fee_charged,
          status: tx.successful ? "success" : "failed",
          memo: tx.memo,
          operationCount: tx.operation_count,
          envelopeXdr: tx.envelope_xdr,
          resultXdr: tx.result_xdr,
          resultMetaXdr: tx.result_meta_xdr,
        };
      } catch (error: any) {
        if (error?.response?.status === 404) {
          throw new StellarNotFoundException("Transaction", txHash);
        }
        this.logger.error(`Failed to fetch transaction ${txHash}`, error);
        throw new StellarNetworkException(
          `Failed to fetch transaction ${txHash}`,
          error
        );
      }
    }, "getTransaction");
  }

  /**
   * Monitors a transaction until it reaches a terminal state.
   * Polls with exponential backoff.
   */
  async monitorTransaction(
    txHash: string,
    maxAttempts = 20,
    pollIntervalMs = 3000
  ): Promise<MonitorTransactionResult> {
    this.logger.log(`Monitoring transaction: ${txHash}`);
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;
      this.rateLimiter.checkLimit();

      try {
        const tx = await this.horizon.transactions().transaction(txHash).call();
        const status: TransactionStatus = tx.successful ? "success" : "failed";

        this.logger.log(
          `Transaction ${txHash} reached status: ${status} after ${attempts} attempt(s)`
        );

        if (status === "failed") {
          return {
            hash: txHash,
            status,
            ledger: tx.ledger_attr,
            createdAt: tx.created_at,
            errorMessage: tx.result_xdr,
            attempts,
          };
        }

        return {
          hash: txHash,
          status,
          ledger: tx.ledger_attr,
          createdAt: tx.created_at,
          attempts,
        };
      } catch (error: any) {
        if (error?.response?.status === 404) {
          this.logger.debug(
            `Transaction ${txHash} not found yet (attempt ${attempts}/${maxAttempts})`
          );
          if (attempts < maxAttempts) {
            await sleep(pollIntervalMs);
            continue;
          }
          return { hash: txHash, status: "not_found", attempts };
        }

        this.logger.warn(
          `Error polling transaction ${txHash}:`,
          error?.message
        );
        if (attempts < maxAttempts) {
          await sleep(pollIntervalMs);
        }
      }
    }

    this.logger.warn(
      `Transaction ${txHash} monitoring timed out after ${attempts} attempts`
    );
    return { hash: txHash, status: "pending", attempts };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Invokes a read-only Soroban contract method and returns the native result.
   */
  private async callContract<T>(
    contractId: string,
    method: string,
    args: StellarSdk.xdr.ScVal[]
  ): Promise<T> {
    const account = await this.soroban
      .getAccount(StellarSdk.Keypair.random().publicKey())
      .catch(() => {
        // Use a dummy account for read-only simulations
        return {
          accountId: () => StellarSdk.Keypair.random().publicKey(),
          sequenceNumber: () => "0",
          incrementSequenceNumber: () => {},
        } as any;
      });

    const contract = new StellarSdk.Contract(contractId);
    const tx = new StellarSdk.TransactionBuilder(account as any, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase:
        this.config.network === "mainnet"
          ? StellarSdk.Networks.PUBLIC
          : StellarSdk.Networks.TESTNET,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(Math.floor(this.config.requestTimeout / 1000))
      .build();

    const simulation = await this.soroban.simulateTransaction(tx);

    if (StellarSdk.rpc.Api.isSimulationError(simulation)) {
      throw new StellarContractException(
        `Contract call failed: ${method}`,
        simulation.error
      );
    }

    const result = (
      simulation as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse
    ).result;

    if (!result) {
      throw new StellarContractException(
        `No result from contract call: ${method}`
      );
    }

    return StellarSdk.scValToNative(result.retval) as T;
  }

  /**
   * Wraps an async operation with circuit breaker and retry + exponential backoff logic.
   * Uses background retry configuration for resilient polling.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return this.circuitBreaker.execute(async () => {
      const config = BACKGROUND_RETRY_CONFIG;
      let lastError: unknown;

      for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        try {
          const result = await Promise.race<T>([
            operation(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new StellarTimeoutException(operationName)),
                this.config.requestTimeout
              )
            ),
          ]);
          
          if (attempt > 1) {
            this.logger.log(
              `${operationName} succeeded on attempt ${attempt}/${config.maxAttempts}`
            );
          }
          
          return result;
        } catch (error) {
          lastError = error;

          // Check if error is retryable
          const retryable = isRetryableError(error);
          
          if (!retryable || attempt === config.maxAttempts) {
            if (!retryable) {
              this.logger.error(
                `${operationName} failed with terminal error (not retryable)`,
                error
              );
            } else {
              this.logger.error(
                `${operationName} failed after ${config.maxAttempts} attempts`,
                error
              );
            }
            throw error;
          }

          const delay = calculateBackoffDelay(attempt, config);
          this.logger.warn(
            `${operationName} failed (attempt ${attempt}/${config.maxAttempts}). ` +
            `Retrying in ${Math.round(delay)}ms... Error: ${error instanceof Error ? error.message : String(error)}`
          );
          await sleep(delay);
        }
      }

      this.logger.error(
        `${operationName} failed after ${config.maxAttempts} attempts`
      );
      throw lastError;
    });
  }

  /**
   * Maps a raw Soroban event to a BurnEvent.
   */
  private parseBurnEvent(
    event: StellarSdk.rpc.Api.EventResponse,
    tokenAddress: string
  ): BurnEvent {
    try {
      const parsed = this.parseContractEvent(event);
      return {
        txHash: parsed.txHash,
        ledger: parsed.ledger,
        timestamp: parsed.timestamp,
        from: parsed.topics[0] as string,
        amount: String(parsed.data),
        tokenAddress,
      };
    } catch (error) {
      throw new StellarParseException("Failed to parse burn event", error);
    }
  }
}
