import { describe, it, expect } from 'vitest';
import { getExplorerUrl, getTxUrl, getContractUrl, getAccountUrl } from '../explorer';

describe('explorer URL builder', () => {
  describe('getExplorerUrl', () => {
    it('builds a testnet tx URL', () => {
      expect(getExplorerUrl('tx', 'ABC123', 'testnet')).toBe(
        'https://stellar.expert/explorer/testnet/tx/ABC123',
      );
    });

    it('builds a mainnet tx URL', () => {
      expect(getExplorerUrl('tx', 'ABC123', 'mainnet')).toBe(
        'https://stellar.expert/explorer/public/tx/ABC123',
      );
    });

    it('builds a testnet contract URL', () => {
      expect(getExplorerUrl('contract', 'CABC123', 'testnet')).toBe(
        'https://stellar.expert/explorer/testnet/contract/CABC123',
      );
    });

    it('builds a mainnet contract URL', () => {
      expect(getExplorerUrl('contract', 'CABC123', 'mainnet')).toBe(
        'https://stellar.expert/explorer/public/contract/CABC123',
      );
    });

    it('builds a testnet account URL', () => {
      expect(getExplorerUrl('account', 'GABC123', 'testnet')).toBe(
        'https://stellar.expert/explorer/testnet/account/GABC123',
      );
    });

    it('builds a mainnet account URL', () => {
      expect(getExplorerUrl('account', 'GABC123', 'mainnet')).toBe(
        'https://stellar.expert/explorer/public/account/GABC123',
      );
    });
  });

  describe('getTxUrl', () => {
    it('returns a testnet transaction link', () => {
      expect(getTxUrl('TXHASH1', 'testnet')).toBe(
        'https://stellar.expert/explorer/testnet/tx/TXHASH1',
      );
    });

    it('returns a mainnet transaction link', () => {
      expect(getTxUrl('TXHASH1', 'mainnet')).toBe(
        'https://stellar.expert/explorer/public/tx/TXHASH1',
      );
    });
  });

  describe('getContractUrl', () => {
    it('returns a testnet contract link', () => {
      expect(getContractUrl('CCONTRACTID', 'testnet')).toBe(
        'https://stellar.expert/explorer/testnet/contract/CCONTRACTID',
      );
    });

    it('returns a mainnet contract link', () => {
      expect(getContractUrl('CCONTRACTID', 'mainnet')).toBe(
        'https://stellar.expert/explorer/public/contract/CCONTRACTID',
      );
    });
  });

  describe('getAccountUrl', () => {
    it('returns a testnet account link', () => {
      expect(getAccountUrl('GACCOUNTID', 'testnet')).toBe(
        'https://stellar.expert/explorer/testnet/account/GACCOUNTID',
      );
    });

    it('returns a mainnet account link', () => {
      expect(getAccountUrl('GACCOUNTID', 'mainnet')).toBe(
        'https://stellar.expert/explorer/public/account/GACCOUNTID',
      );
    });
  });
});
