import { logger } from "../../../lib/logger";
import { prisma } from "../../../lib/prisma";

export async function writeAdminAuditLog(input: {
  societyId?: string | null;
  adminId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        societyId: input.societyId ?? undefined,
        adminId: input.adminId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? undefined,
        metadata: input.metadata as object | undefined,
      },
    });
  } catch (e) {
    logger.error({ err: e }, "[audit] Failed to persist admin audit");
  }
}
