/**
 * Shared API client — issue #1154
 *
 * Every outbound fetch made by a frontend service should go through this
 * module so that `X-Transaction-Id` and `X-Correlation-Id` are consistently
 * attached to all backend requests.
 *
 * Header reference (mirrors the backend header reference in
 * `request-logging.middleware.ts`):
 *
 * | Header              | Set by        | Description                                            |
 * |---------------------|---------------|--------------------------------------------------------|
 * | X-Transaction-Id    | Frontend      | Logical tx ID — one per page load / user flow          |
 * | X-Correlation-Id    | Frontend      | Per-call trace ID (UUID v4)                            |
 *
 * Usage
 * ─────
 *   import { apiClient } from './apiClient';
 *
 *   // Simple GET
 *   const data = await apiClient.get<MyType>('/api/campaigns/1');
 *
 *   // POST with body
 *   const result = await apiClient.post<Result>('/api/votes', { support: true });
 *
 *   // Raw fetch (same headers injected)
 *   const res = await apiClient.fetch('/api/health');
 */

import { getTransactionId, TXN_ID_HEADER } from '../utils/transactionId';

const CORRELATION_ID_HEADER = 'X-Correlation-Id' as const;
const NETWORK_HEADER = 'X-Network' as const;

type ApiNetwork = 'testnet' | 'mainnet';

let currentNetwork: ApiNetwork = 'testnet';

/**
 * Set the network (testnet/mainnet) that should be attached to every
 * outbound request via the X-Network header. Called by `useNetwork` whenever
 * the user switches networks so the backend can route to the correct
 * Horizon endpoint.
 */
export function setApiNetwork(network: ApiNetwork): void {
  currentNetwork = network;
}

/** Get the network currently attached to outbound requests. */
export function getApiNetwork(): ApiNetwork {
  return currentNetwork;
}

/** Generate a UUID-v4-like correlation ID (no external deps). */
function generateCorrelationId(): string {
  // crypto.randomUUID() is available in modern browsers and Node 18+
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Build the propagation headers that must be attached to every request.
 * A fresh correlation ID is generated per call; the transaction ID is stable
 * for the lifetime of the page session.
 */
export function buildRequestHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);

  // Transaction ID — page-scoped, stable across multiple calls in one flow
  if (!headers.has(TXN_ID_HEADER)) {
    headers.set(TXN_ID_HEADER, getTransactionId());
  }

  // Correlation ID — unique per request, used to correlate log lines for one call
  if (!headers.has(CORRELATION_ID_HEADER)) {
    headers.set(CORRELATION_ID_HEADER, generateCorrelationId());
  }

  // Network — selects which Horizon endpoint the backend should use
  if (!headers.has(NETWORK_HEADER)) {
    headers.set(NETWORK_HEADER, currentNetwork);
  }

  return headers;
}

/**
 * Get the base API URL from environment (Vite).
 * Falls back to empty string so relative paths work in dev proxy setups.
 */
function getBaseUrl(): string {
  try {
    // import.meta.env is injected by Vite at build time
    return (import.meta as any)?.env?.VITE_API_BASE_URL ?? '';
  } catch {
    return '';
  }
}

/** Generic JSON fetch with propagation headers. */
async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = path.startsWith('http') ? path : `${getBaseUrl()}${path}`;
  const headers = buildRequestHeaders(init.headers);

  // Ensure JSON content type for bodies
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  const response = await fetch(url, { ...init, headers });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(response.status, response.statusText, text);
  }

  // Return raw Response for callers that need headers/status (e.g. stream endpoints)
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }
  return response.text() as unknown as Promise<T>;
}

/** Typed API error with HTTP status. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string
  ) {
    super(`API error ${status} ${statusText}: ${body}`);
    this.name = 'ApiError';
  }
}

export const apiClient = {
  /** Raw fetch with propagation headers — returns the Response object. */
  fetch: (path: string, init: RequestInit = {}): Promise<Response> => {
    const url = path.startsWith('http') ? path : `${getBaseUrl()}${path}`;
    const headers = buildRequestHeaders(init.headers);
    return fetch(url, { ...init, headers });
  },

  get: <T = unknown>(path: string, init?: RequestInit) =>
    apiFetch<T>(path, { ...init, method: 'GET' }),

  post: <T = unknown>(path: string, body?: unknown, init?: RequestInit) =>
    apiFetch<T>(path, {
      ...init,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  put: <T = unknown>(path: string, body?: unknown, init?: RequestInit) =>
    apiFetch<T>(path, {
      ...init,
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  patch: <T = unknown>(path: string, body?: unknown, init?: RequestInit) =>
    apiFetch<T>(path, {
      ...init,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  delete: <T = unknown>(path: string, init?: RequestInit) =>
    apiFetch<T>(path, { ...init, method: 'DELETE' }),
};

export default apiClient;
