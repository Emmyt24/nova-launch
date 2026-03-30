import { Request, Response, NextFunction } from 'express';

interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  responseTime: number;
  userAgent?: string;
  ip?: string;
  requestId?: string;
  correlationId?: string;
  txHash?: string;
}

export const requestLoggingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] as string || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Propagate or generate correlation ID (frontend passes x-correlation-id)
  const correlationId = (req.headers['x-correlation-id'] as string) || requestId;

  // Attach IDs to request and response headers
  req.headers['x-request-id'] = requestId;
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Correlation-Id', correlationId);

  // Capture response
  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    // tx hash may be present in body or query (read-only, never log signed XDR)
    const txHash = (req.body?.txHash as string | undefined) || (req.query?.txHash as string | undefined);

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: res.statusCode,
      responseTime,
      userAgent: req.headers['user-agent'],
      ip: req.ip || req.socket.remoteAddress,
      requestId,
      correlationId,
      ...(txHash && { txHash }),
    };

    const logMessage = JSON.stringify(logEntry);

    if (res.statusCode >= 500) {
      console.error(logMessage);
    } else if (res.statusCode >= 400) {
      console.warn(logMessage);
    } else {
      console.log(logMessage);
    }
  });

  next();
};
