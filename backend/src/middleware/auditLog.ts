import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth";
import { Database } from "../config/database";

export const auditLog = (action: string, resource: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);
    let beforeState: any = null;
    let afterState: any = null;

    // Capture before state for updates/deletes
    if (req.method === "PATCH" || req.method === "DELETE") {
      const resourceId = req.params.id;
      if (resource === "token") {
        beforeState = await Database.findTokenById(resourceId);
      } else if (resource === "user") {
        beforeState = await Database.findUserById(resourceId);
      }
    }

    res.json = function (data: any) {
      // Capture after state
      if (req.method === "PATCH" || req.method === "POST") {
        afterState = data;
      }

      // Log the action for both admin and non-admin authenticated users
      const actor = req.admin || req.user;
      if (actor) {
        Database.createAuditLog({
          adminId: actor.id,
          action: `${req.method} ${action}`,
          resource,
          resourceId: req.params.id || "N/A",
          beforeState,
          afterState,
          ipAddress: req.ip || req.socket.remoteAddress || "unknown",
          userAgent: req.headers["user-agent"] || "unknown",
        }).catch((err) => console.error("Audit log error:", err));
      }

      return originalJson(data);
    };

    next();
  };
};
