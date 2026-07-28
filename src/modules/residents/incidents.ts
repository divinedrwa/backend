import { Prisma, UserRole } from "@prisma/client";
import { Router } from "express";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

router.use(requireAuth);

/** GET /api/residents/incidents — read-only society incident log for residents. */
router.get(
  "/incidents",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const { search, severity } = req.query;

      const whereClause: Prisma.IncidentWhereInput = { societyId };

      if (typeof search === "string" && search.trim()) {
        const term = search.trim();
        whereClause.OR = [
          { title: { contains: term, mode: "insensitive" } },
          { description: { contains: term, mode: "insensitive" } },
        ];
      }
      if (typeof severity === "string" && severity.trim()) {
        whereClause.severity = severity.trim() as Prisma.IncidentWhereInput["severity"];
      }

      const pagination = getPagination(req);
      const [incidents, total] = await Promise.all([
        prisma.incident.findMany({
          where: whereClause,
          include: {
            guard: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: pagination.take,
          skip: pagination.skip,
        }),
        prisma.incident.count({ where: whereClause }),
      ]);

      return res.json({
        incidents,
        ...paginationMeta(total, incidents.length, pagination),
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
