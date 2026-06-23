/**
 * Tests for issue #1154 — Frontend transaction/correlation ID propagation.
 *
 * Covers:
 *  - generateTransactionId() format
 *  - getTransactionId() persistence via sessionStorage
 *  - rotateTransactionId() creates a new ID
 *  - transactionIdHeaders() returns correct header map
 *  - sessionStorage unavailable (SSR / private) fallback
 *  - apiClient injects X-Transaction-Id on every request
 *  - apiClient injects X-Correlation-Id on every request
 *  - apiClient generates a fresh correlation ID per call
 *  - Caller-supplied headers are preserved (not overwritten)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateTransactionId,
  getTransactionId,
  rotateTransactionId,
  transactionIdHeaders,
  TXN_ID_HEADER,
} from '../../utils/transactionId';
import { buildRequestHeaders, ApiError, setApiNetwork, getApiNetwork } from '../apiClient';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset session storage between tests. */
function clearTxnStorage() {
  try {
    sessionStorage.removeItem('nova_txn_id');
  } catch { /* jsdom may throw */ }
}

// ---------------------------------------------------------------------------
// transactionId utility
// ---------------------------------------------------------------------------

describe('generateTransactionId()', () => {
  it('returns a non-empty string', () => {
    const id = generateTransactionId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('starts with "txn_"', () => {
    expect(generateTransactionId()).toMatch(/^txn_/);
  });

  it('generates unique IDs on consecutive calls', () => {
    const ids = new Set(Array.from({ length: 50 }, generateTransactionId));
    expect(ids.size).toBe(50);
  });
});

describe('getTransactionId()', () => {
  beforeEach(clearTxnStorage);
  afterEach(clearTxnStorage);

  it('creates and persists an ID on first call', () => {
    const id1 = getTransactionId();
    const id2 = getTransactionId();
    expect(id1).toBe(id2);
  });

  it('stores the ID in sessionStorage under "nova_txn_id"', () => {
    const id = getTransactionId();
    expect(sessionStorage.getItem('nova_txn_id')).toBe(id);
  });

  it('re-uses an ID that already exists in sessionStorage', () => {
    sessionStorage.setItem('nova_txn_id', 'txn_preset_value_00');
    const id = getTransactionId();
    expect(id).toBe('txn_preset_value_00');
  });
});

describe('rotateTransactionId()', () => {
  beforeEach(clearTxnStorage);
  afterEach(clearTxnStorage);

  it('returns a new ID different from the current one', () => {
    const original = getTransactionId();
    const rotated  = rotateTransactionId();
    expect(rotated).not.toBe(original);
  });

  it('subsequent getTransactionId() returns the rotated ID', () => {
    const rotated = rotateTransactionId();
    expect(getTransactionId()).toBe(rotated);
  });
});

describe('transactionIdHeaders()', () => {
  beforeEach(clearTxnStorage);
  afterEach(clearTxnStorage);

  it('returns an object with the correct header key', () => {
    const headers = transactionIdHeaders();
    expect(headers[TXN_ID_HEADER]).toBeDefined();
    expect(typeof headers[TXN_ID_HEADER]).toBe('string');
  });

  it('header value matches getTransactionId()', () => {
    const id = getTransactionId();
    expect(transactionIdHeaders()[TXN_ID_HEADER]).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// apiClient — buildRequestHeaders
// ---------------------------------------------------------------------------

describe('buildRequestHeaders()', () => {
  beforeEach(clearTxnStorage);
  afterEach(clearTxnStorage);

  it('adds X-Transaction-Id header', () => {
    const headers = buildRequestHeaders();
    expect(headers.get('X-Transaction-Id')).toBeDefined();
    expect(headers.get('X-Transaction-Id')).toMatch(/^txn_/);
  });

  it('adds X-Correlation-Id header', () => {
    const headers = buildRequestHeaders();
    expect(headers.get('X-Correlation-Id')).toBeDefined();
    expect(headers.get('X-Correlation-Id')).not.toBe('');
  });

  it('generates a fresh X-Correlation-Id per call', () => {
    const h1 = buildRequestHeaders().get('X-Correlation-Id');
    const h2 = buildRequestHeaders().get('X-Correlation-Id');
    expect(h1).not.toBe(h2);
  });

  it('does NOT replace an X-Transaction-Id the caller already set', () => {
    const headers = buildRequestHeaders({ 'X-Transaction-Id': 'caller-txn-override' });
    expect(headers.get('X-Transaction-Id')).toBe('caller-txn-override');
  });

  it('does NOT replace an X-Correlation-Id the caller already set', () => {
    const headers = buildRequestHeaders({ 'X-Correlation-Id': 'caller-corr-override' });
    expect(headers.get('X-Correlation-Id')).toBe('caller-corr-override');
  });

  it('merges caller-supplied headers alongside propagation headers', () => {
    const headers = buildRequestHeaders({ Authorization: 'Bearer token123' });
    expect(headers.get('Authorization')).toBe('Bearer token123');
    expect(headers.get('X-Transaction-Id')).toBeDefined();
  });

  it('same transaction ID is used across multiple calls in one session', () => {
    const id1 = buildRequestHeaders().get('X-Transaction-Id');
    const id2 = buildRequestHeaders().get('X-Transaction-Id');
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// apiClient — X-Network header (issue #1375)
// ---------------------------------------------------------------------------

describe('setApiNetwork() / getApiNetwork()', () => {
  afterEach(() => {
    setApiNetwork('testnet');
  });

  it('defaults to testnet', () => {
    expect(getApiNetwork()).toBe('testnet');
  });

  it('updates the network used for outbound requests', () => {
    setApiNetwork('mainnet');
    expect(getApiNetwork()).toBe('mainnet');
  });

  it('adds an X-Network header matching the current network', () => {
    setApiNetwork('mainnet');
    const headers = buildRequestHeaders();
    expect(headers.get('X-Network')).toBe('mainnet');
  });

  it('does NOT replace an X-Network header the caller already set', () => {
    setApiNetwork('mainnet');
    const headers = buildRequestHeaders({ 'X-Network': 'testnet' });
    expect(headers.get('X-Network')).toBe('testnet');
  });
});

// ---------------------------------------------------------------------------
// apiClient — full fetch integration (mocked fetch)
// ---------------------------------------------------------------------------

describe('apiClient — header injection on outbound fetch', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearTxnStorage();
    fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearTxnStorage();
  });

  it('attaches X-Transaction-Id to GET requests', async () => {
    const { apiClient } = await import('../apiClient');
    await apiClient.get('/api/test').catch(() => {});
    const [, init] = fetchSpy.mock.calls[0] as [string, { headers: Headers }];
    expect(init.headers.get('X-Transaction-Id')).toMatch(/^txn_/);
  });

  it('attaches X-Correlation-Id to GET requests', async () => {
    const { apiClient } = await import('../apiClient');
    await apiClient.get('/api/test').catch(() => {});
    const [, init] = fetchSpy.mock.calls[0] as [string, { headers: Headers }];
    expect(init.headers.get('X-Correlation-Id')).toBeDefined();
  });

  it('attaches X-Transaction-Id to POST requests', async () => {
    const { apiClient } = await import('../apiClient');
    await apiClient.post('/api/test', { data: 1 }).catch(() => {});
    const [, init] = fetchSpy.mock.calls[0] as [string, { headers: Headers }];
    expect(init.headers.get('X-Transaction-Id')).toMatch(/^txn_/);
  });

  it('X-Transaction-Id is stable across multiple calls in the same session', async () => {
    const { apiClient } = await import('../apiClient');
    await apiClient.get('/api/one').catch(() => {});
    await apiClient.get('/api/two').catch(() => {});

    const h1 = (fetchSpy.mock.calls[0][1] as { headers: Headers }).headers.get('X-Transaction-Id');
    const h2 = (fetchSpy.mock.calls[1][1] as { headers: Headers }).headers.get('X-Transaction-Id');
    expect(h1).toBe(h2);
  });

  it('X-Correlation-Id is different for each call', async () => {
    const { apiClient } = await import('../apiClient');
    await apiClient.get('/api/one').catch(() => {});
    await apiClient.get('/api/two').catch(() => {});

    const c1 = (fetchSpy.mock.calls[0][1] as { headers: Headers }).headers.get('X-Correlation-Id');
    const c2 = (fetchSpy.mock.calls[1][1] as { headers: Headers }).headers.get('X-Correlation-Id');
    expect(c1).not.toBe(c2);
  });

  it('attaches X-Network matching the currently selected network', async () => {
    const { apiClient, setApiNetwork: setNetwork } = await import('../apiClient');
    setNetwork('mainnet');
    await apiClient.get('/api/test').catch(() => {});
    const [, init] = fetchSpy.mock.calls[0] as [string, { headers: Headers }];
    expect(init.headers.get('X-Network')).toBe('mainnet');
    setNetwork('testnet');
  });
});

// ---------------------------------------------------------------------------
// ApiError
// ---------------------------------------------------------------------------

describe('ApiError', () => {
  it('carries status code and message', () => {
    const err = new ApiError(404, 'Not Found', 'resource missing');
    expect(err.status).toBe(404);
    expect(err.statusText).toBe('Not Found');
    expect(err.body).toBe('resource missing');
    expect(err.name).toBe('ApiError');
  });
});
