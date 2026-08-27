/**
 * Shared origin-matching logic for the backend's two independent CORS configurations.
 *
 * @see ./cors.ts - Express API bootstrap (src/index.ts), sourced from FRONTEND_URL
 * @see ../auth/cors.config.ts - NestJS auth service bootstrap (src/auth/main.ts), sourced from ALLOWED_ORIGINS
 *
 * The two bootstraps remain intentionally separate (different processes, different
 * env vars), but both build their `origin` check from this single helper so the
 * matching semantics can't silently diverge between them.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[]
): boolean {
  // Requests with no Origin header (server-to-server calls, curl, mobile apps) are always allowed.
  if (!origin) return true;

  return allowedOrigins.includes("*") || allowedOrigins.includes(origin);
}
