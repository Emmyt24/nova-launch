import { Keypair, TransactionBuilder, Networks, Operation, Asset, BASE_FEE, SorobanRpc, xdr, Address, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { StellarService } from './stellarService';
import { logger } from '../utils/logger';

export interface DeployTokenParams {
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: string;
  adminPublicKey: string;
}

export interface DeployTokenResult {
  contractId: string;
  transactionHash: string;
  ledger: number;
}

/**
 * Integration surface for invoking the token factory contract on Soroban.
 * Batch deploy and other services route real on-chain deploys through here
 * instead of synthesizing addresses.
 */
export class StellarServiceIntegration {
  private readonly stellarService: StellarService;
  private readonly factoryContractId: string;
  private readonly sorobanServer: SorobanRpc.Server;
  private readonly networkPassphrase: string;

  constructor(stellarService: StellarService) {
    this.stellarService = stellarService;
    this.factoryContractId =
      process.env.TOKEN_FACTORY_CONTRACT_ID || '';
    this.networkPassphrase =
      process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
    this.sorobanServer = new SorobanRpc.Server(
      process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
    );
  }

  /**
   * Deploy a token by invoking the factory contract's `deploy` method.
   * Returns the real contract id produced on-chain.
   */
  async deployToken(params: DeployTokenParams): Promise<DeployTokenResult> {
    if (!this.factoryContractId) {
      throw new Error(
        'TOKEN_FACTORY_CONTRACT_ID is not configured; cannot deploy token'
      );
    }

    const sourceKeypair = this.stellarService.getSourceKeypair();
    const sourceAccount = await this.sorobanServer.getAccount(
      sourceKeypair.publicKey()
    );

    const contract = new (require('@stellar/stellar-sdk').Contract)(
      this.factoryContractId
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          'deploy',
          nativeToScVal(params.name, { type: 'string' }),
          nativeToScVal(params.symbol, { type: 'string' }),
          nativeToScVal(params.decimals, { type: 'u32' }),
          nativeToScVal(params.initialSupply, { type: 'i128' }),
          new Address(params.adminPublicKey).toScVal()
        )
      )
      .setTimeout(60)
      .build();

    const prepared = await this.sorobanServer.prepareTransaction(tx);
    prepared.sign(sourceKeypair);

    const sendResponse = await this.sorobanServer.sendTransaction(prepared);
    if (sendResponse.status === 'ERROR') {
      throw new Error(
        `Soroban deploy submission failed: ${JSON.stringify(
          sendResponse.errorResult
        )}`
      );
    }

    const result = await this.pollTransaction(sendResponse.hash);
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(
        `Soroban deploy transaction ${sendResponse.hash} did not succeed: ${result.status}`
      );
    }

    const contractId = this.extractContractId(result);
    logger.info('Deployed token via factory contract', {
      contractId,
      transactionHash: sendResponse.hash,
    });

    return {
      contractId,
      transactionHash: sendResponse.hash,
      ledger: result.ledger,
    };
  }

  private async pollTransaction(
    hash: string
  ): Promise<SorobanRpc.Api.GetTransactionResponse> {
    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await this.sorobanServer.getTransaction(hash);
      if (response.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for Soroban transaction ${hash}`);
  }

  private extractContractId(
    result: SorobanRpc.Api.GetTransactionResponse
  ): string {
    if (
      result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS ||
      !result.returnValue
    ) {
      throw new Error('Soroban deploy returned no contract id');
    }
    const native = scValToNative(result.returnValue);
    if (typeof native !== 'string' || !native.startsWith('C')) {
      throw new Error(
        `Soroban deploy returned an unexpected contract id: ${String(native)}`
      );
    }
    return native;
  }
}
