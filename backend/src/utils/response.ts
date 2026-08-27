export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
    correlationId?: string;
  };
  timestamp: string;
  correlationId?: string;
}

export function successResponse<T>(data: T, correlationId?: string): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    ...(correlationId && { correlationId }),
  };
}

export function errorResponse(
  error: {
    code: string;
    message: string;
    details?: any;
  },
  correlationId?: string
): ApiResponse<null> {
  return {
    success: false,
    error: {
      ...error,
      ...(correlationId && { correlationId }),
    },
    timestamp: new Date().toISOString(),
    ...(correlationId && { correlationId }),
  };
}
