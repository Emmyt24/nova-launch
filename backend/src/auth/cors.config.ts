import { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

export function buildCorsOptions(allowedOrigins: string[]): CorsOptions {
  if (allowedOrigins.includes("*")) {
    throw new Error(
      "CORS misconfiguration: wildcard '*' cannot be combined with credentials: true. " +
        "This would allow any origin to make authenticated cross-origin requests. " +
        "Use an explicit list of allowed origins instead."
    );
  }

  return {
    origin: (origin, callback) => {
      // Allow server-to-server calls (no origin header)
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS policy`));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Api-Key",
      "X-Request-Id",
    ],
    exposedHeaders: [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "X-Request-Id",
    ],
    credentials: true,
    maxAge: 86400, // 24 hours preflight cache
  };
}
