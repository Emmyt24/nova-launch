type Network = 'testnet' | 'mainnet';
type ExplorerLinkType = 'tx' | 'contract' | 'account';

const EXPLORER_BASE: Record<Network, string> = {
  testnet: 'https://stellar.expert/explorer/testnet',
  mainnet: 'https://stellar.expert/explorer/public',
};

export function getExplorerUrl(type: ExplorerLinkType, id: string, network: Network): string {
  return `${EXPLORER_BASE[network]}/${type}/${id}`;
}

export function getTxUrl(txHash: string, network: Network): string {
  return getExplorerUrl('tx', txHash, network);
}

export function getContractUrl(contractId: string, network: Network): string {
  return getExplorerUrl('contract', contractId, network);
}

export function getAccountUrl(accountId: string, network: Network): string {
  return getExplorerUrl('account', accountId, network);
}
