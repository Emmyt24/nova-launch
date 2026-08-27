import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Database } from "../config/database";
import { User } from "../types";

/**
 * The admin JWT secret is required in production and development.
 * In test environments a clearly-marked, non-guessable default is used so
 * test suites work without a real secret configured.
 *
 * If ADMIN_JWT_SECRET is unset outside a test environment the process throws
 * at module load time (fail-fast) rather than silently accepting a guessable
 * default that would allow anyone who has read the source to forge admin JWTs.
 */
function resolveAdminJwtSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === "test") {
    // Non-guessable placeholder — clearly scoped to the test environment.
    return "test-only-admin-jwt-secret-not-for-production";
  }

  throw new Error(
    "ADMIN_JWT_SECRET environment variable is required but was not set. " +
      "Please configure it before starting the server."
  );
}

const ADMIN_JWT_SECRET = resolveAdminJwtSecret();

export interface AuthRequest extends Request {
  admin?: User;
}

export const authenticateAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const decoded = jwt.verify(token, ADMIN_JWT_SECRET) as { userId: string };
    const user = await Database.findUserById(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    if (user.banned) {
      return res.status(403).json({ error: "Account banned" });
    }

    if (user.role === "user") {
      return res.status(403).json({ error: "Admin access required" });
    }

    req.admin = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

export const requireRole = (...roles: User["role"][]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.admin) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({
        error: "Insufficient permissions",
        required: roles,
        current: req.admin.role,
      });
    }

    next();
  };
};

export const requireSuperAdmin = requireRole("super_admin");
