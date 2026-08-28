import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenantContext {
  /** Unique tenant identifier */
  id: string;
  /** Optional human-readable tenant name */
  name?: string;
  /** Source that resolved the tenant */
  source: "header" | "jwt";
}

/** Augmented request carrying tenant context */
export interface TenantRequest extends Request {
  tenant?: TenantContext;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allowed tenant ID format: 1–64 alphanumeric / hyphen / underscore chars */
const TENANT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validates a raw tenant ID string.
 * Returns the sanitised value or null if invalid.
 */
export function validateTenantId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return TENANT_ID_RE.test(trimmed) ? trimmed : null;
}

/**
 * Extracts a tenant ID from a decoded JWT payload.
 * Checks `payload.tenantId` and `payload.tenant_id`.
 */
export function extractTenantFromJwt(
  token: string,
  secret: string
): TenantContext | null {
  try {
    const payload = jwt.verify(token, secret) as Record<string, unknown>;
    const raw = payload.tenantId ?? payload.tenant_id;
    const id = validateTenantId(raw);
    if (!id) return null;
    const name =
      typeof payload.tenantName === "string" ? payload.tenantName : undefined;
    return { id, name, source: "jwt" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface TenancyOptions {
  /**
   * When true, requests without a valid tenant are rejected with 400.
   * When false (default), the middleware is permissive — tenant may be absent.
   */
  required?: boolean;
  /**
   * JWT secret used to decode bearer tokens for tenant extraction.
   * Falls back to the JWT_SECRET env var when omitted.
   */
  jwtSecret?: string;
}

/**
 * Tenant isolation middleware.
 *
 * Resolution order:
 *   1. `X-Tenant-ID` request header
 *   2. `tenantId` / `tenant_id` claim in the Bearer JWT
 *
 * On success, attaches a `TenantContext` to `req.tenant`.
 * When `required: true` and no valid tenant is found, responds 400.
 */
export function tenantMiddleware(options: TenancyOptions = {}) {
  const { required = false } = options;
  const secret = options.jwtSecret ?? process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      "JWT secret is required for tenantMiddleware. " +
      "Provide options.jwtSecret or set JWT_SECRET environment variable."
    );
  }

  return function resolveTenant(
    req: TenantRequest,
    res: Response,
    next: NextFunction
  ): void {

    // 1. Header-based resolution
    const headerValue = req.headers["x-tenant-id"];
    if (typeof headerValue === "string") {
      const id = validateTenantId(headerValue);
      if (id) {
        req.tenant = { id, source: "header" };
        return next();
      }
      // Header present but invalid — always reject
      res.status(400).json({ error: "Invalid X-Tenant-ID header value" });
      return;
    }

    // 2. JWT-based resolution
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const tenant = extractTenantFromJwt(token, secret);
      if (tenant) {
        req.tenant = tenant;
        return next();
      }
    }

    // 3. No tenant found
    if (required) {
      res.status(400).json({ error: "Tenant identification required" });
      return;
    }

    next();
  };
}

/**
 * Guard middleware — rejects requests whose `req.tenant.id` does not match
 * the `:tenantId` route parameter. Use after `tenantMiddleware()`.
 *
 * Prevents cross-tenant data access on parameterised routes such as
 * `/api/tenants/:tenantId/tokens`.
 */
export function requireTenantMatch(
  req: TenantRequest,
  res: Response,
  next: NextFunction
): void {
  const paramId = req.params.tenantId;
  if (!paramId) return next(); // route has no :tenantId param — skip

  if (!req.tenant) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (req.tenant.id !== paramId) {
    res.status(403).json({ error: "Access to this tenant is forbidden" });
    return;
  }

  next();
}
