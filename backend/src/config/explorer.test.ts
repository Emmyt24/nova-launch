import {
  getExplorerConfig,
  getExplorerUrl,
  detectExplorerLinkType,
  validateEnv,
  EXPLORER_PROVIDERS,
  DEFAULT_EXPLORER_PROVIDER,
  type ExplorerProvider,
  type ExplorerNetwork,
  type ExplorerEntityType,
} from './explorer';

describe('explorer config', () => {
  describe('getExplorerConfig', () => {
    const networks: ExplorerNetwork[] = ['testnet', 'mainnet', 'futurenet'];
    const providers: ExplorerProvider[] = ['stellar.expert', 'stellarchain'];

    it.each(networks)('resolves config for %s network', (network) => {
      const config = getExplorerConfig(network);
      expect(config).toBeDefined();
      expect(config.network).toBe(network);
      expect(config.baseUrl).toBeTruthy();
    });

    it.each(providers)('resolves config for %s provider', (provider) => {
      const config = getExplorerConfig('testnet', provider);
      expect(config).toBeDefined();
      expect(config.provider).toBe(provider);
      expect(config.baseUrl).toBeTruthy();
    });

    it('resolves stellar.expert URLs per network', () => {
      expect(getExplorerConfig('mainnet', 'stellar.expert').baseUrl).toContain(
        'stellar.expert',
      );
      expect(getExplorerConfig('testnet', 'stellar.expert').baseUrl).toContain(
        'stellar.expert',
      );
      expect(getExplorerConfig('futurenet', 'stellar.expert').baseUrl).toContain(
        'stellar.expert',
      );
    });

    it('resolves stellarchain URLs per network', () => {
      expect(getExplorerConfig('mainnet', 'stellarchain').baseUrl).toContain(
        'stellarchain',
      );
      expect(getExplorerConfig('testnet', 'stellarchain').baseUrl).toContain(
        'stellarchain',
      );
      expect(getExplorerConfig('futurenet', 'stellarchain').baseUrl).toContain(
        'stellarchain',
      );
    });

    it('produces distinct base URLs for each network/provider combination', () => {
      const urls = new Set<string>();
      for (const network of networks) {
        for (const provider of providers) {
          urls.add(getExplorerConfig(network, provider).baseUrl);
        }
      }
      expect(urls.size).toBe(networks.length * providers.length);
    });

    it('falls back to the default provider when none is supplied', () => {
      const config = getExplorerConfig('testnet');
      expect(config.provider).toBe(DEFAULT_EXPLORER_PROVIDER);
    });

    it('falls back to the default provider for an unknown provider', () => {
      const config = getExplorerConfig(
        'testnet',
        'unknown-provider' as ExplorerProvider,
      );
      expect(config.provider).toBe(DEFAULT_EXPLORER_PROVIDER);
    });

    it('exposes all supported providers', () => {
      expect(EXPLORER_PROVIDERS).toEqual(
        expect.arrayContaining(['stellar.expert', 'stellarchain']),
      );
    });
  });

  describe('getExplorerUrl', () => {
    const entityTypes: ExplorerEntityType[] = [
      'tx',
      'account',
      'contract',
      'asset',
    ];
    const networks: ExplorerNetwork[] = ['testnet', 'mainnet', 'futurenet'];
    const providers: ExplorerProvider[] = ['stellar.expert', 'stellarchain'];

    it.each(entityTypes)('generates a URL for %s entities', (entityType) => {
      const url = getExplorerUrl(entityType, 'SAMPLE_ID', {
        network: 'testnet',
      });
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^https?:\/\//);
      expect(url).toContain('SAMPLE_ID');
    });

    it.each(networks)('generates URLs for %s network', (network) => {
      for (const entityType of entityTypes) {
        const url = getExplorerUrl(entityType, 'SAMPLE_ID', { network });
        expect(url).toMatch(/^https?:\/\//);
        expect(url).toContain('SAMPLE_ID');
      }
    });

    it.each(providers)('generates URLs for %s provider', (provider) => {
      for (const entityType of entityTypes) {
        const url = getExplorerUrl(entityType, 'SAMPLE_ID', {
          network: 'testnet',
          provider,
        });
        expect(url).toMatch(/^https?:\/\//);
        expect(url).toContain('SAMPLE_ID');
      }
    });

    it('uses the default provider when none is supplied', () => {
      const withDefault = getExplorerUrl('tx', 'SAMPLE_ID', {
        network: 'testnet',
      });
      const explicit = getExplorerUrl('tx', 'SAMPLE_ID', {
        network: 'testnet',
        provider: DEFAULT_EXPLORER_PROVIDER,
      });
      expect(withDefault).toBe(explicit);
    });

    it('produces distinct URLs for each entity type', () => {
      const urls = new Set<string>();
      for (const entityType of entityTypes) {
        urls.add(
          getExplorerUrl(entityType, 'SAMPLE_ID', { network: 'testnet' }),
        );
      }
      expect(urls.size).toBe(entityTypes.length);
    });

    it('produces distinct URLs for each provider', () => {
      const expert = getExplorerUrl('tx', 'SAMPLE_ID', {
        network: 'testnet',
        provider: 'stellar.expert',
      });
      const chain = getExplorerUrl('tx', 'SAMPLE_ID', {
        network: 'testnet',
        provider: 'stellarchain',
      });
      expect(expert).not.toBe(chain);
    });
  });

  describe('detectExplorerLinkType', () => {
    it('detects account links', () => {
      const url = getExplorerUrl('account', 'GABCDEF', { network: 'testnet' });
      expect(detectExplorerLinkType(url)).toBe('account');
    });

    it('detects contract links', () => {
      const url = getExplorerUrl('contract', 'CABCDEF', {
        network: 'testnet',
      });
      expect(detectExplorerLinkType(url)).toBe('contract');
    });

    it('detects transaction links', () => {
      const url = getExplorerUrl('tx', 'abc123', { network: 'testnet' });
      expect(detectExplorerLinkType(url)).toBe('tx');
    });

    it('detects asset links', () => {
      const url = getExplorerUrl('asset', 'USDC-GABCDEF', {
        network: 'testnet',
      });
      expect(detectExplorerLinkType(url)).toBe('asset');
    });

    it('returns null for unrecognized URLs', () => {
      expect(detectExplorerLinkType('https://example.com/foo')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(detectExplorerLinkType('')).toBeNull();
    });
  });

  describe('validateEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('accepts a valid STELLAR_EXPLORER_PROVIDER value', () => {
      process.env.STELLAR_EXPLORER_PROVIDER = 'stellarchain';
      expect(() => validateEnv()).not.toThrow();
    });

    it('accepts stellar.expert as a valid provider', () => {
      process.env.STELLAR_EXPLORER_PROVIDER = 'stellar.expert';
      expect(() => validateEnv()).not.toThrow();
    });

    it('rejects an invalid STELLAR_EXPLORER_PROVIDER value', () => {
      process.env.STELLAR_EXPLORER_PROVIDER = 'not-a-real-provider';
      expect(() => validateEnv()).toThrow();
    });

    it('defaults correctly when STELLAR_EXPLORER_PROVIDER is unset', () => {
      delete process.env.STELLAR_EXPLORER_PROVIDER;
      expect(() => validateEnv()).not.toThrow();
      const config = getExplorerConfig('testnet');
      expect(config.provider).toBe(DEFAULT_EXPLORER_PROVIDER);
    });
  });
});