/**
 * Structured Logging Configuration for Nova Launch
 * Provides centralized, queryable logging with trace correlation
 */

import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';

// Environment configuration
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const SERVICE_NAME = process.env.SERVICE_NAME || 'nova-launch';
const LOG_LEVEL = process.env.LOG_LEVEL || (ENVIRONMENT === 'production' ? 'info' : 'debug');
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';

// Log levels
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6,
};

// Custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf((info: any) => {
    const { timestamp, level, message, traceId, spanId, service, ...meta } = info;
    
    const logEntry = {
      '@timestamp': timestamp,
      level,
      message,
      service: service || SERVICE_NAME,
      environment: ENVIRONMENT,
      network: STELLAR_NETWORK,
      ...(traceId && { traceId }),
      ...(spanId && { spanId }),
      ...meta,
    };

    return JSON.stringify(logEntry);
  })
);

// Transport configuration
const transports: winston.transport[] = [];

// Console transport for development
if (ENVIRONMENT === 'development') {
  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  );
} else {
  // JSON console output for production (captured by log aggregators)
  transports.push(
    new winston.transports.Console({
      format: logFormat,
    })
  );
}

// File transports for local development and testing
if (ENVIRONMENT !== 'production') {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: LOG_LEVEL,
  levels: LOG_LEVELS,
  format: logFormat,
  transports,
  exitOnError: false,
});

/**
 * Enhanced logger with Web3 specific functionality
 */
export class StructuredLogger {
  private static instance: StructuredLogger;
  private logger: winston.Logger;
  private traceId: string | null = null;
  private spanId: string | null = null;

  private constructor() {
    this.logger = logger;
  }

  static getInstance(): StructuredLogger {
    if (!StructuredLogger.instance) {
      StructuredLogger.instance = new StructuredLogger();
    }
    return StructuredLogger.instance;
  }

  /**
   * Set trace context for distributed tracing
   */
  setTraceContext(traceId: string, spanId?: string): void {
    this.traceId = traceId;
    this.spanId = spanId || null;
  }

  /**
   * Clear trace context
   */
  clearTraceContext(): void {
    this.traceId = null;
    this.spanId = null;
  }

  /**
   * Create child logger with additional context
   */
  child(context: Record<string, any>): StructuredLogger {
    const childLogger = new StructuredLogger();
    childLogger.logger = this.logger.child(context);
    childLogger.traceId = this.traceId;
    childLogger.spanId = this.spanId;
    return childLogger;
  }

  /**
   * Log with automatic trace context injection
   */
  private log(level: string, message: string, meta: Record<string, any> = {}): void {
    const logMeta = {
      ...meta,
      ...(this.traceId && { traceId: this.traceId }),
      ...(this.spanId && { spanId: this.spanId }),
    };

    this.logger.log(level, message, logMeta);
  }

  // Standard log levels
  error(message: string, meta: Record<string, any> = {}): void {
    this.log('error', message, meta);
  }

  warn(message: string, meta: Record<string, any> = {}): void {
    this.log('warn', message, meta);
  }

  info(message: string, meta: Record<string, any> = {}): void {
    this.log('info', message, meta);
  }

  http(message: string, meta: Record<string, any> = {}): void {
    this.log('http', message, meta);
  }

  debug(message: string, meta: Record<string, any> = {}): void {
    this.log('debug', message, meta);
  }

  // Web3 specific logging methods
  
  /**
   * Log smart contract interactions
   */
  logContractInteraction(params: {
    action: 'deploy' | 'invoke' | 'query';
    contractAddress?: string;
    method?: string;
    transactionHash?: string;
    correlationId?: string;
    gasUsed?: number;
    success: boolean;
    duration?: number;
    error?: Error;
    metadata?: Record<string, any>;
  }): void {
    const level = params.success ? 'info' : 'error';
    const message = `Contract ${params.action} ${params.success ? 'succeeded' : 'failed'}`;
    
    this.log(level, message, {
      category: 'contract',
      action: params.action,
      contractAddress: params.contractAddress,
      method: params.method,
      transactionHash: params.transactionHash,
      correlationId: params.correlationId,
      gasUsed: params.gasUsed,
      success: params.success,
      duration: params.duration,
      error: params.error?.message,
      errorStack: params.error?.stack,
      ...params.metadata,
    });
  }

  /**
   * Log wallet interactions
   */
  logWalletInteraction(params: {
    action: 'connect' | 'disconnect' | 'sign' | 'reject';
    walletAddress?: string;
    walletType?: string;
    success: boolean;
    error?: Error;
    metadata?: Record<string, any>;
  }): void {
    const level = params.success ? 'info' : 'warn';
    const message = `Wallet ${params.action} ${params.success ? 'succeeded' : 'failed'}`;
    
    // Hash wallet address for privacy
    const hashedAddress = params.walletAddress ? 
      this.hashSensitiveData(params.walletAddress) : undefined;
    
    this.log(level, message, {
      category: 'wallet',
      action: params.action,
      walletAddress: hashedAddress,
      walletType: params.walletType,
      success: params.success,
      error: params.error?.message,
      ...params.metadata,
    });
  }

  /**
   * Log transaction lifecycle
   */
  logTransaction(params: {
    stage: 'initiated' | 'signed' | 'submitted' | 'confirmed' | 'failed';
    transactionHash?: string;
    correlationId?: string;
    fromAddress?: string;
    toAddress?: string;
    amount?: string;
    fee?: string;
    blockNumber?: number;
    success?: boolean;
    error?: Error;
    metadata?: Record<string, any>;
  }): void {
    const level = params.stage === 'failed' || params.error ? 'error' : 'info';
    const message = `Transaction ${params.stage}`;
    
    this.log(level, message, {
      category: 'transaction',
      stage: params.stage,
      transactionHash: params.transactionHash,
      correlationId: params.correlationId,
      fromAddress: params.fromAddress ? this.hashSensitiveData(params.fromAddress) : undefined,
      toAddress: params.toAddress ? this.hashSensitiveData(params.toAddress) : undefined,
      amount: params.amount,
      fee: params.fee,
      blockNumber: params.blockNumber,
      success: params.success,
      error: params.error?.message,
      errorStack: params.error?.stack,
      ...params.metadata,
    });
  }

  /**
   * Log RPC provider interactions
   */
  logRPCCall(params: {
    provider: string;
    method: string;
    success: boolean;
    duration: number;
    error?: Error;
    metadata?: Record<string, any>;
  }): void {
    const level = params.success ? 'debug' : 'warn';
    const message = `RPC call ${params.method} ${params.success ? 'succeeded' : 'failed'}`;
    
    this.log(level, message, {
      category: 'rpc',
      provider: params.provider,
      method: params.method,
      success: params.success,
      duration: params.duration,
      error: params.error?.message,
      ...params.metadata,
    });
  }

  /**
   * Log user activity
   */
  logUserActivity(params: {
    userId?: string;
    action: string;
    resource?: string;
    success: boolean;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, any>;
  }): void {
    const message = `User ${params.action} ${params.resource || ''}`;
    
    this.log('info', message, {
      category: 'user_activity',
      userId: params.userId ? this.hashSensitiveData(params.userId) : undefined,
      action: params.action,
      resource: params.resource,
      success: params.success,
      ipAddress: params.ipAddress ? this.hashSensitiveData(params.ipAddress) : undefined,
      userAgent: params.userAgent,
      ...params.metadata,
    });
  }

  /**
   * Log business events
   */
  logBusinessEvent(params: {
    event: string;
    value?: number;
    currency?: string;
    userId?: string;
    metadata?: Record<string, any>;
  }): void {
    this.log('info', `Business event: ${params.event}`, {
      category: 'business',
      event: params.event,
      value: params.value,
      currency: params.currency,
      userId: params.userId ? this.hashSensitiveData(params.userId) : undefined,
      ...params.metadata,
    });
  }

  /**
   * Log security events
   */
  logSecurityEvent(params: {
    event: 'authentication_failed' | 'suspicious_activity' | 'rate_limit_exceeded' | 'unauthorized_access';
    severity: 'low' | 'medium' | 'high' | 'critical';
    userId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, any>;
  }): void {
    const level = params.severity === 'critical' || params.severity === 'high' ? 'error' : 'warn';
    
    this.log(level, `Security event: ${params.event}`, {
      category: 'security',
      event: params.event,
      severity: params.severity,
      userId: params.userId ? this.hashSensitiveData(params.userId) : undefined,
      ipAddress: params.ipAddress ? this.hashSensitiveData(params.ipAddress) : undefined,
      userAgent: params.userAgent,
      ...params.metadata,
    });
  }

  /**
   * Log performance metrics
   */
  logPerformance(params: {
    operation: string;
    duration: number;
    success: boolean;
    metadata?: Record<string, any>;
  }): void {
    this.log('info', `Performance: ${params.operation}`, {
      category: 'performance',
      operation: params.operation,
      duration: params.duration,
      success: params.success,
      ...params.metadata,
    });
  }

  /**
   * Hash sensitive data for privacy
   */
  private hashSensitiveData(data: string): string {
    // Simple hash for demonstration - use proper hashing in production
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `hashed_${Math.abs(hash)}`;
  }
}

/**
 * Express middleware for request logging
 */
export function createLoggingMiddleware() {
  const logger = StructuredLogger.getInstance();

  return (req: any, res: any, next: any) => {
    const startTime = Date.now();
    const traceId = req.headers['x-trace-id'] || uuidv4();
    const spanId = uuidv4();

    // Set trace context
    logger.setTraceContext(traceId, spanId);

    // Add trace ID to response headers
    res.setHeader('x-trace-id', traceId);

    // Log request
    logger.http('HTTP request started', {
      method: req.method,
      url: req.url,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
      traceId,
      spanId,
    });

    // Override res.end to log response
    const originalEnd = res.end;
    res.end = function(...args: any[]) {
      const duration = Date.now() - startTime;
      
      logger.http('HTTP request completed', {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration,
        traceId,
        spanId,
      });

      // Clear trace context
      logger.clearTraceContext();

      originalEnd.apply(res, args);
    };

    next();
  };
}

/**
 * Async context manager for trace correlation
 */
export class TraceContext {
  private static contexts = new Map<string, { traceId: string; spanId: string }>();

  static set(key: string, traceId: string, spanId: string): void {
    this.contexts.set(key, { traceId, spanId });
  }

  static get(key: string): { traceId: string; spanId: string } | undefined {
    return this.contexts.get(key);
  }

  static clear(key: string): void {
    this.contexts.delete(key);
  }

  static withContext<T>(
    traceId: string,
    spanId: string,
    callback: () => Promise<T> | T
  ): Promise<T> | T {
    const logger = StructuredLogger.getInstance();
    const contextKey = `${traceId}-${spanId}`;
    
    this.set(contextKey, traceId, spanId);
    logger.setTraceContext(traceId, spanId);

    try {
      const result = callback();
      
      if (result instanceof Promise) {
        return result.finally(() => {
          this.clear(contextKey);
          logger.clearTraceContext();
        });
      } else {
        this.clear(contextKey);
        logger.clearTraceContext();
        return result;
      }
    } catch (error) {
      this.clear(contextKey);
      logger.clearTraceContext();
      throw error;
    }
  }
}

// Export singleton instance
export const structuredLogger = StructuredLogger.getInstance();

// Export types
export interface ContractInteractionLog {
  action: 'deploy' | 'invoke' | 'query';
  contractAddress?: string;
  method?: string;
  transactionHash?: string;
  correlationId?: string;
  gasUsed?: number;
  success: boolean;
  duration?: number;
  error?: Error;
  metadata?: Record<string, any>;
}

export interface WalletInteractionLog {
  action: 'connect' | 'disconnect' | 'sign' | 'reject';
  walletAddress?: string;
  walletType?: string;
  success: boolean;
  error?: Error;
  metadata?: Record<string, any>;
}

export interface TransactionLog {
  stage: 'initiated' | 'signed' | 'submitted' | 'confirmed' | 'failed';
  transactionHash?: string;
  correlationId?: string;
  fromAddress?: string;
  toAddress?: string;
  amount?: string;
  fee?: string;
  blockNumber?: number;
  success?: boolean;
  error?: Error;
  metadata?: Record<string, any>;
}