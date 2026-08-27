import { AsyncLocalStorage } from 'async_hooks';

/**
 * Parsed representation of an incoming W3C `traceparent` header
 * (https://www.w3.org/TR/trace-context/#traceparent-header).
 *
 * Format: `<version>-<trace-id>-<parent-id>-<trace-flags>`
 *   e.g. `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 */
export interface TraceContext {
  /** 2 hex chars — currently always "00". */
  version: string;
  /** 32 hex chars — the trace ID. */
  traceId: string;
  /** 16 hex chars — the parent/span ID. */
  parentId: string;
  /** 2 hex chars — trace flags (e.g. sampled bit). */
  traceFlags: string;
  /** The raw, unmodified header value, for verbatim re-propagation. */
  raw: string;
}

interface RequestContext {
  correlationId: string;
  transactionId?: string;
  /** Parsed incoming W3C `traceparent` context, when present on the request. */
  traceContext?: TraceContext;
  /** Current tenant, when the request has been scoped to one (see `runWithTenant`). */
  tenantId?: string;
  /** When true, tenant-scoped Prisma queries skip the automatic `tenantId` filter (see `runBypassing`). */
  bypassTenant?: boolean;
}

export const asyncContext = new AsyncLocalStorage<RequestContext>();

export function getCorrelationId(): string | undefined {
  return asyncContext.getStore()?.correlationId;
}

export function getTransactionId(): string | undefined {
  return asyncContext.getStore()?.transactionId;
}

export function getTraceContext(): TraceContext | undefined {
  return asyncContext.getStore()?.traceContext;
}

export function getTenantId(): string | undefined {
  return asyncContext.getStore()?.tenantId;
}

export function isBypassingTenant(): boolean {
  return asyncContext.getStore()?.bypassTenant ?? false;
}

export function runWithContext<T>(
  correlationId: string,
  fn: () => T,
  transactionId?: string,
  traceContext?: TraceContext
): T {
  return asyncContext.run({ correlationId, transactionId, traceContext }, fn);
}

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  const store = asyncContext.getStore();
  return asyncContext.run(
    {
      correlationId: store?.correlationId ?? '',
      transactionId: store?.transactionId,
      tenantId,
    },
    fn
  );
}

export function runBypassing<T>(fn: () => T): T {
  const store = asyncContext.getStore();
  return asyncContext.run(
    {
      correlationId: store?.correlationId ?? '',
      transactionId: store?.transactionId,
      tenantId: store?.tenantId,
      bypassTenant: true,
    },
    fn
  );
}
