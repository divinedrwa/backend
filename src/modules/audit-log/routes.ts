import { UserRole } from "@prisma/client";
import { Router } from "express";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

/**
 * GET /api/audit-log — paginated list of audit events for this society.
 *
 * Query params:
 *   action   — filter by action type (e.g. "DELETE_USER")
 *   entityType — filter by entity (e.g. "User", "Society")
 *   adminId  — filter by acting user
 */
router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const societyId = req.auth!.societyId;

    const where: Record<string, unknown> = { societyId };
    if (typeof req.query.action === "string" && req.query.action) {
      where.action = req.query.action;
    }
    if (typeof req.query.entityType === "string" && req.query.entityType) {
      where.entityType = req.query.entityType;
    }
    if (typeof req.query.adminId === "string" && req.query.adminId) {
      where.adminId = req.query.adminId;
    }

    const [logs, total] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
        include: {
          admin: { select: { id: true, name: true, username: true } },
        },
      }),
      prisma.adminAuditLog.count({ where }),
    ]);

    return res.json({
      logs,
      ...paginationMeta(total, logs.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
