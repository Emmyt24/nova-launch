import * as Sentry from '@sentry/browser';

type Severity = 'low' | 'medium' | 'high';

// ---------------------------------------------------------------------------
// Correlation ID helpers
// ---------------------------------------------------------------------------

/** Generate a lightweight correlation ID for a frontend operation. */
export function generateCorrelationId(): string {
    return `cid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface CorrelationContext {
    correlationId: string;
    txHash?: string;
    walletAddress?: string;
    network?: string;
}

/**
 * Log a structured integration event that can be correlated across
 * frontend → backend → webhook hops.
 *
 * Rules:
 *  - txHash is the primary chain key after submission; include it whenever available.
 *  - Never log signed XDR blobs or secrets.
 */
export function logIntegrationEvent(
    event: string,
    ctx: CorrelationContext,
    extra?: Record<string, unknown>
): void {
    const SENSITIVE = /(secret|xdr|signed|mnemonic|seed|private)/i;
    const safeExtra: Record<string, unknown> = {};
    if (extra) {
        for (const [k, v] of Object.entries(extra)) {
            safeExtra[k] = SENSITIVE.test(k) ? '[REDACTED]' : v;
        }
    }

    const payload = {
        event,
        correlationId: ctx.correlationId,
        ...(ctx.txHash && { txHash: ctx.txHash }),
        ...(ctx.network && { network: ctx.network }),
        timestamp: new Date().toISOString(),
        ...safeExtra,
    };

    console.info('[Integration]', JSON.stringify(payload));
}

export interface ErrorContext {
    action?: string;
    feature?: string;
    userId?: string;
    walletAddress?: string;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
}

interface LogPayload {
    timestamp: string;
    severity: Severity;
    message: string;
    stack?: string;
    name?: string;
    context?: Record<string, unknown>;
    url: string;
    userAgent: string;
    environment: string;
}

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(password|secret|token|api[-_]?key|authorization|cookie|private|seed|mnemonic)/i;

function sanitizeValue(value: unknown): unknown {
    if (value == null) {
        return value;
    }

    if (typeof value === 'string') {
        return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeValue(item));
    }

    if (typeof value === 'object') {
        const input = value as Record<string, unknown>;
        const output: Record<string, unknown> = {};

        for (const [key, nestedValue] of Object.entries(input)) {
            if (SENSITIVE_KEY_PATTERN.test(key)) {
                output[key] = REDACTED;
                continue;
            }
            output[key] = sanitizeValue(nestedValue);
        }

        return output;
    }

    return value;
}

export class LoggingService {
    private static initialized = false;
    private static sentryInitialized = false;
    private static lastUserAction = 'app_initialized';

    static init(): void {
        if (this.initialized || typeof window === 'undefined') {
            return;
        }

        this.initialized = true;

        const setAction = (value: string) => {
            this.lastUserAction = value;
        };

        window.addEventListener(
            'click',
            (event) => {
                const target = event.target as HTMLElement | null;
                const id = target?.id ? `#${target.id}` : '';
                const className = target?.className && typeof target.className === 'string'
                    ? `.${target.className.split(' ')[0]}`
                    : '';
                setAction(`click:${target?.tagName?.toLowerCase() || 'unknown'}${id || className}`);
            },
            { capture: true }
        );

        window.addEventListener(
            'submit',
            (event) => {
                const target = event.target as HTMLFormElement | null;
                setAction(`submit:${target?.id || target?.name || 'form'}`);
            },
            { capture: true }
        );

        window.addEventListener(
            'keydown',
            (event) => {
                const keyboardEvent = event as KeyboardEvent;
                if (keyboardEvent.key === 'Enter' || keyboardEvent.key === 'Escape') {
                    setAction(`keyboard:${keyboardEvent.key}`);
                }
            },
            { capture: true }
        );
    }

    static logError(error: Error, severity: Severity, context?: ErrorContext): void {
        const sanitizedContext = sanitizeValue({
            ...context,
            lastAction: this.lastUserAction,
        }) as Record<string, unknown>;

        const payload: LogPayload = {
            timestamp: new Date().toISOString(),
            severity,
            message: error.message,
            stack: error.stack,
            name: error.name,
            context: sanitizedContext,
            url: typeof window !== 'undefined' ? window.location.href : 'n/a',
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a',
            environment: import.meta.env.MODE,
        };

        if (severity === 'high') {
            console.error('[ErrorHandler]', payload);
            return;
        }

        if (severity === 'medium') {
            console.warn('[ErrorHandler]', payload);
            return;
        }

        console.info('[ErrorHandler]', payload);
    }

    static reportToMonitoring(error: Error, context?: ErrorContext): void {
        if (!import.meta.env.PROD || !import.meta.env.VITE_SENTRY_DSN) {
            return;
        }

        try {
            this.ensureSentryInitialized();

            const sanitizedContext = sanitizeValue({
                ...context,
                lastAction: this.lastUserAction,
            }) as Record<string, string | number | boolean>;

            Sentry.captureException(error, {
                extra: sanitizedContext as Record<string, string | number | boolean | null | undefined>,
                tags: {
                    severity: this.inferSeverity(error),
                    feature: context?.feature || 'unknown',
                },
            });
        } catch (reportError) {
            console.warn('Failed to report error to monitoring service:', reportError);
        }
    }

    private static ensureSentryInitialized(): void {
        if (this.sentryInitialized) {
            return;
        }

        Sentry.init({
            dsn: import.meta.env.VITE_SENTRY_DSN,
            environment: import.meta.env.MODE,
            beforeSend: (event) => (sanitizeValue(event) as typeof event) || null,
        } as Parameters<typeof Sentry.init>[0]);

        this.sentryInitialized = true;
    }

    private static inferSeverity(error: Error): Severity {
        const text = `${error.name} ${error.message}`.toLowerCase();
        if (text.includes('network') || text.includes('timeout')) {
            return 'medium';
        }
        if (text.includes('fatal') || text.includes('crash') || text.includes('transaction failed')) {
            return 'high';
        }
        return 'low';
    }
}
