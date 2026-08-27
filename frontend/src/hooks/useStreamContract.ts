/**
 * Contract-interaction hook for the payment-streaming/vesting feature
 * (Issue #1765). Distinct from `useVaultContract.ts` (Vaults feature) —
 * do not modify that file; this is a new, parallel hook.
 */
import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc as Soroban,
  Transaction,
  Account,
  Keypair,
} from '@stellar/stellar-sdk';
import { getNetworkConfig, STELLAR_CONFIG } from '../config/stellar';
import { WalletService } from '../services/wallet';
import type { PaymentStreamOnChain } from '../types';

type Network = 'testnet' | 'mainnet';

async function submit(
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
  signerAddress: string,
  network: Network,
): Promise<string> {
  const config = getNetworkConfig(network);
  const server = new Soroban.Server(config.sorobanRpcUrl);
  const contract = new Contract(STELLAR_CONFIG.factoryContractId);
  const account = await server.getAccount(signerAddress);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const signedXdr = await WalletService.signTransaction(prepared.toXDR());
  if (!signedXdr) throw new Error(`${method} transaction signing was rejected or cancelled`);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase) as Transaction;

  const response = await server.sendTransaction(signedTx);
  if (response.status === 'ERROR') throw new Error(`${method} transaction failed`);

  let getResponse = await server.getTransaction(response.hash);
  while (getResponse.status === 'NOT_FOUND') {
    await new Promise((r) => setTimeout(r, 1000));
    getResponse = await server.getTransaction(response.hash);
  }
  if (getResponse.status === 'FAILED') throw new Error(`${method} transaction failed on-chain`);

  return response.hash;
}

/** Claim the currently-vested balance of a stream. */
export async function claimStream(streamId: string, recipientAddress: string, network: Network = 'testnet'): Promise<{ txHash: string }> {
  const txHash = await submit(
    'claim_stream',
    [nativeToScVal(recipientAddress, { type: 'address' }), nativeToScVal(BigInt(streamId), { type: 'u64' })],
    recipientAddress,
    network,
  );
  return { txHash };
}

/** Cancel a stream (creator or admin only). */
export async function cancelStream(streamId: string, actorAddress: string, network: Network = 'testnet'): Promise<{ txHash: string }> {
  const txHash = await submit(
    'cancel_stream',
    [nativeToScVal(actorAddress, { type: 'address' }), nativeToScVal(BigInt(streamId), { type: 'u64' })],
    actorAddress,
    network,
  );
  return { txHash };
}

/** Read a single stream's on-chain state (read-only simulation, no signing). */
export async function getStream(streamId: string, network: Network = 'testnet'): Promise<PaymentStreamOnChain | null> {
  const config = getNetworkConfig(network);
  const server = new Soroban.Server(config.sorobanRpcUrl);
  const contract = new Contract(STELLAR_CONFIG.factoryContractId);
  const dummyAccount = new Account(Keypair.random().publicKey(), '0');

  const tx = new TransactionBuilder(dummyAccount, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(contract.call('get_stream', nativeToScVal(BigInt(streamId), { type: 'u64' })))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!Soroban.Api.isSimulationSuccess(sim) || !sim.result) return null;

  const raw = scValToNative(sim.result.retval) as Record<string, unknown>;
  if (!raw || raw['StreamNotFound'] !== undefined) return null;

  return {
    id: String(raw['id'] ?? streamId),
    creator: String(raw['creator'] ?? ''),
    recipient: String(raw['recipient'] ?? ''),
    tokenIndex: Number(raw['token_index'] ?? 0),
    totalAmount: String(raw['total_amount'] ?? '0'),
    claimedAmount: String(raw['claimed_amount'] ?? '0'),
    startTime: Number(raw['start_time'] ?? 0),
    endTime: Number(raw['end_time'] ?? 0),
    cliffTime: Number(raw['cliff_time'] ?? 0),
    metadata: raw['metadata'] ? String(raw['metadata']) : null,
    cancelled: Boolean(raw['cancelled']),
    paused: Boolean(raw['paused']),
    disputed: Boolean(raw['disputed']),
    milestones: [],
  };
}
