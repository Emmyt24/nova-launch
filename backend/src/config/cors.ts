import { CorsOptions } from "cors";
import { isOriginAllowed } from "./allowedOrigins";

/**
 * CORS configuration options for Nova Launch Backend's Express API bootstrap
 * (src/index.ts). This governs the Express process only — the NestJS auth
 * service bootstrap (src/auth/main.ts) has its own, separately-configured CORS
 * policy sourced from ALLOWED_ORIGINS; see ../auth/cors.config.ts. The two are
 * intentionally separate, but share their origin-matching logic via
 * ./allowedOrigins so it can't silently diverge between them.
 */
export const corsOptions: CorsOptions = {
  /**
   * Allowed Origins
   * In production, this should be the exact URL of the frontend.
   * Multiple origins can be allowed by using an array.
   */
  origin: (origin, callback) => {
    const allowedOrigins = [
      process.env.FRONTEND_URL || "http://localhost:5173",
      // Add other production URLs here
    ];

    if (isOriginAllowed(origin, allowedOrigins)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },

  /**
   * Allowed HTTP methods
   */
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],

  /**
   * Allowed headers
   */
  allowedHeaders: ["Content-Type", "Authorization"],

  /**
   * Whether to allow credentials (cookies, authorization headers, etc.)
   */
  credentials: true,

  /**
   * How long the results of a preflight request can be cached (in seconds)
   * 86400 seconds = 24 hours
   */
  maxAge: 86400,

  /**
   * Preflight requests handling is done automatically by the cors middleware
   */
  preflightContinue: false,

  optionsSuccessStatus: 204,
};

/**
 * Startup validation for the Express CORS policy.
 *
 * Throws when the configuration is unsafe, so a misconfigured deployment fails
 * fast instead of silently serving credentialed responses to arbitrary origins:
 *  - a wildcard ("*") origin is rejected in production
 *  - FRONTEND_URL is required in production
 *  - every configured origin must be a valid http(s) URL
 */
export function validateCorsConfig(
  env: NodeJS.ProcessEnv = process.env
): void {
  const isProduction = env.NODE_ENV === "production";
  const raw = env.FRONTEND_URL;

  if (!raw || raw.trim() === "") {
    if (isProduction) {
      throw new Error("FRONTEND_URL must be set in production for CORS");
    }
    return;
  }

  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  for (const origin of origins) {
    if (origin === "*") {
      if (isProduction) {
        throw new Error("Wildcard CORS origin is not allowed in production");
      }
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Invalid CORS origin protocol: ${origin}`);
    }
  }
}
