import { Request } from "express";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";

/**
 * Centralised audit logging service.
 *
 * Persists an `AdminAuditLog` row for security-sensitive operations.
 * All methods are fire-and-forget — failures are logged but never throw
 * so they can't break the primary request flow.
 */

export interface AuditEntry {
  societyId?: string | null;
  adminId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Extract IP + User-Agent from the Express request. */
export function requestMeta(req: Request): { ipAddress: string; userAgent: string } {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress ?? "unknown";
  return {
    ipAddress: ip,
    userAgent: (req.headers["user-agent"] ?? "unknown").slice(0, 512),
  };
}

/** Write a single audit log row. Never throws. */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        societyId: entry.societyId ?? undefined,
        adminId: entry.adminId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? undefined,
        metadata: entry.metadata as object | undefined,
        ipAddress: entry.ipAddress ?? undefined,
        userAgent: entry.userAgent ?? undefined,
      },
    });
  } catch (e) {
    logger.error({ err: e }, "[audit] Failed to persist audit log");
  }
}

/** Convenience: log from a request context with auto-extracted IP/UA. */
export function auditFromRequest(
  req: Request,
  entry: Omit<AuditEntry, "ipAddress" | "userAgent">,
): void {
  const meta = requestMeta(req);
  // Fire-and-forget
  void writeAuditLog({ ...entry, ...meta });
}
