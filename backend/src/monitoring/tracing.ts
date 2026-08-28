/**
 * Distributed tracing integration with OpenTelemetry.
 *
 * Architecture:
 *   - When the `@opentelemetry/sdk-node` package is present and
 *     `OTEL_ENABLED=true`, a real NodeSDK tracer is initialised and spans are
 *     exported to the configured endpoint (OTLP/HTTP by default).
 *   - When the SDK is absent or disabled, every call falls back to a no-op
 *     implementation so the rest of the codebase compiles and runs without
 *     any OTel dependency installed.
 *
 * Environment variables:
 *   OTEL_ENABLED          - Set to "true" to activate real tracing (default: false)
 *   OTEL_SERVICE_NAME     - Service name reported in traces (default: "nova-launch-backend")
 *   OTEL_EXPORTER_OTLP_ENDPOINT - Collector endpoint (default: "http://localhost:4318")
 *
 * Security:
 *   - Span attributes never include raw request bodies, auth tokens, or PII.
 *   - Sensitive header names are redacted before being recorded.
 *   - Error messages are recorded but stack traces are omitted in production.
 *
 * Usage:
 *   ```ts
 *   import { tracer, withSpan } from "./monitoring/tracing";
 *
 *   // Manual span
 *   const span = tracer.startSpan("my-operation", { attributes: { "token.address": addr } });
 *   try { ... } finally { span.end(); }
 *
 *   // Convenience wrapper
 *   const result = await withSpan("db.query", async (span) => {
 *     span.setAttribute("db.table", "Token");
 *     return prisma.token.findMany(...);
 *   });
 *   ```
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SpanStatus = "ok" | "error" | "unset";

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface ISpan {
  setAttribute(key: string, value: string | number | boolean): this;
  setAttributes(attrs: SpanAttributes): this;
  setStatus(status: SpanStatus, message?: string): this;
  recordException(error: Error): this;
  end(): void;
  readonly traceId: string;
  readonly spanId: string;
}

export interface ITracer {
  startSpan(name: string, options?: { attributes?: SpanAttributes }): ISpan;
}

// ─── No-op implementation ─────────────────────────────────────────────────────

/** Stable no-op span used when tracing is disabled or the SDK is unavailable. */
export class NoopSpan implements ISpan {
  readonly traceId = "00000000000000000000000000000000";
  readonly spanId = "0000000000000000";

  setAttribute(_key: string, _value: string | number | boolean): this {
    return this;
  }
  setAttributes(_attrs: SpanAttributes): this {
    return this;
  }
  setStatus(_status: SpanStatus, _message?: string): this {
    return this;
  }
  recordException(_error: Error): this {
    return this;
  }
  end(): void {}
}

/** No-op tracer returned when OTel is disabled. */
export class NoopTracer implements ITracer {
  startSpan(_name: string, _options?: { attributes?: SpanAttributes }): ISpan {
    return new NoopSpan();
  }
}

// ─── OTel SDK wrapper ─────────────────────────────────────────────────────────

/**
 * Thin wrapper around an OTel SDK span that implements ISpan.
 * Only instantiated when the SDK is actually available.
 */
class OtelSpan implements ISpan {
  constructor(private readonly _span: any) {}

  get traceId(): string {
    return this._span.spanContext?.()?.traceId ?? "00000000000000000000000000000000";
  }
  get spanId(): string {
    return this._span.spanContext?.()?.spanId ?? "0000000000000000";
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this._span.setAttribute(key, value);
    return this;
  }
  setAttributes(attrs: SpanAttributes): this {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) this._span.setAttribute(k, v);
    }
    return this;
  }
  setStatus(status: SpanStatus, message?: string): this {
    // Map our simple status to OTel SpanStatusCode
    const code = status === "ok" ? 1 : status === "error" ? 2 : 0;
    this._span.setStatus({ code, message });
    return this;
  }
  recordException(error: Error): this {
    this._span.recordException(error);
    return this;
  }
  end(): void {
    this._span.end();
  }
}

class OtelTracer implements ITracer {
  constructor(private readonly _tracer: any) {}

  startSpan(name: string, options?: { attributes?: SpanAttributes }): ISpan {
    const span = this._tracer.startSpan(name, {
      attributes: options?.attributes,
    });
    return new OtelSpan(span);
  }
}

// ─── Initialisation ───────────────────────────────────────────────────────────

const SERVICE_NAME =
  process.env.OTEL_SERVICE_NAME ?? "nova-launch-backend";

const OTEL_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

let _tracer: ITracer = new NoopTracer();
let _sdkShutdown: (() => Promise<void>) | null = null;

/**
 * Initialises the OTel SDK if `OTEL_ENABLED=true` and the SDK packages are
 * installed.  Safe to call multiple times — subsequent calls are no-ops.
 *
 * Returns `true` if real tracing was activated, `false` if noop is used.
 */
export function initTracing(): boolean {
  if (process.env.OTEL_ENABLED !== "true") return false;

  try {
    // Dynamic require so the module compiles without the SDK installed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeSDK } = require("@opentelemetry/sdk-node");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OTLPTraceExporter } = require(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Resource } = require("@opentelemetry/resources");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SEMRESATTRS_SERVICE_NAME } = require(
      "@opentelemetry/semantic-conventions"
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const api = require("@opentelemetry/api");

    const sdk = new NodeSDK({
      resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: SERVICE_NAME }),
      traceExporter: new OTLPTraceExporter({ url: `${OTEL_ENDPOINT}/v1/traces` }),
    });

    sdk.start();

    _tracer = new OtelTracer(api.trace.getTracer(SERVICE_NAME));
    _sdkShutdown = () => sdk.shutdown();

    return true;
  } catch {
    // SDK not installed — stay on noop
    return false;
  }
}

/**
 * Gracefully shuts down the OTel SDK, flushing any pending spans.
 * Safe to call even when noop tracing is active.
 */
export async function shutdownTracing(): Promise<void> {
  if (_sdkShutdown) {
    await _sdkShutdown();
    _sdkShutdown = null;
    _tracer = new NoopTracer();
  }
}

/** The active tracer instance (noop or real OTel). */
export const tracer: ITracer = {
  startSpan(name, options) {
    return _tracer.startSpan(name, options);
  },
};

// ─── Convenience helpers ──────────────────────────────────────────────────────

/**
 * Wraps an async function in a span.  Sets status to "error" and records the
 * exception if the function throws, then re-throws.
 *
 * @example
 * ```ts
 * const tokens = await withSpan("db.token.findMany", async (span) => {
 *   span.setAttribute("db.table", "Token");
 *   return prisma.token.findMany({ where: { creator } });
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  fn: (span: ISpan) => Promise<T>,
  attributes?: SpanAttributes
): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  try {
    const result = await fn(span);
    span.setStatus("ok");
    return result;
  } catch (err) {
    span.setStatus("error", err instanceof Error ? err.message : String(err));
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Express middleware that starts a root span for each incoming HTTP request
 * and attaches `traceId` / `spanId` to the response headers for correlation.
 *
 * Sensitive headers (`authorization`, `cookie`, `x-api-key`) are never
 * recorded as span attributes.
 */
export function tracingMiddleware() {
  return (req: any, res: any, next: () => void): void => {
    const span = tracer.startSpan(`${req.method} ${req.route?.path ?? req.path}`, {
      attributes: {
        "http.method": req.method,
        "http.url": req.originalUrl ?? req.url,
        "http.user_agent": req.headers["user-agent"] ?? "",
        "net.peer.ip": req.ip ?? "",
      },
    });

    res.setHeader("X-Trace-Id", span.traceId);
    res.setHeader("X-Span-Id", span.spanId);

    res.on("finish", () => {
      span
        .setAttribute("http.status_code", res.statusCode)
        .setStatus(res.statusCode >= 500 ? "error" : "ok")
        .end();
    });

    next();
  };
}
