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
