/**
 * Request ID propagation for Stellar RPC / Horizon calls (#2186).
 *
 * The Stellar SDK servers expose an axios-compatible `httpClient`. Registering
 * a request interceptor lets every RPC call carry the current request's
 * propagation headers (X-Request-Id, X-Correlation-Id, X-Transaction-Id,
 * traceparent) without threading them through each call site.
 */

import { buildPropagationHeaders } from '../outboundHttpClient';

interface InterceptableHttpClient {
  interceptors?: {
    request?: {
      use: (onFulfilled: (config: any) => any) => unknown;
    };
  };
}

/**
 * Merge propagation headers into an outgoing request config. Headers already
 * set by the caller are never overwritten.
 */
export function applyPropagationHeaders<T extends { headers?: any }>(config: T): T {
  const propagation = buildPropagationHeaders();
  const headers = config.headers ?? {};

  for (const [key, value] of Object.entries(propagation)) {
    const existing =
      typeof headers.get === 'function' ? headers.get(key) : headers[key];
    if (existing !== undefined && existing !== null && existing !== '') continue;

    if (typeof headers.set === 'function') {
      headers.set(key, value);
    } else {
      headers[key] = value;
    }
  }

  config.headers = headers;
  return config;
}

/**
 * Attach the propagation interceptor to a Stellar SDK server instance.
 * Returns the same server for convenient chaining. A server without an
 * interceptable `httpClient` is returned unchanged.
 */
export function withRequestIdPropagation<S extends object>(server: S): S {
  const httpClient = (server as { httpClient?: InterceptableHttpClient }).httpClient;
  httpClient?.interceptors?.request?.use((config) => applyPropagationHeaders(config));
  return server;
}
