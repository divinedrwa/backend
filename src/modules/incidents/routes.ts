import { IncidentSeverity, UserRole } from "@prisma/client";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const incidentCreateRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: "Too many incident reports, please try again later",
  keyGenerator: (req) => req.ip ?? "unknown",
});

const createIncidentSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10),
  severity: z.nativeEnum(IncidentSeverity),
  location: z.string().optional(),
  photoUrl: z.string().url().optional()
});

const resolveIncidentSchema = z.object({
  resolvedAt: z.string().datetime()
});

router.use(requireAuth);

// List incidents (admin sees all, guard sees own)
router.get("/", async (req, res, next) => {
  try {
    const whereClause: { societyId: string; reportedBy?: string } = {
      societyId: req.auth!.societyId,
    };

    // Guards see only their own reports
    if (req.auth!.role === UserRole.GUARD) {
      whereClause.reportedBy = req.auth!.userId;
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
});

// Report incident (guards and admins)
router.post(
  "/",
  incidentCreateRateLimiter,
  requireRole(UserRole.GUARD, UserRole.ADMIN),
  validateBody(createIncidentSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createIncidentSchema>;

      const incident = await prisma.incident.create({
        data: {
          societyId: req.auth!.societyId,
          reportedBy: req.auth!.userId,
          title: body.title,
          description: body.description,
          severity: body.severity,
          location: body.location,
          photoUrl: body.photoUrl
        },
        include: {
          guard: {
            select: {
              id: true,
              name: true
            }
          }
        }
      });

      return res.status(201).json({ incident });
    } catch (error) {
      next(error);
    }
  }
);

// Resolve incident (admin)
router.patch(
  "/:id/resolve",
  requireRole(UserRole.ADMIN),
  validateBody(resolveIncidentSchema),
  async (req, res, next) => {
    try {
      const { resolvedAt } = req.body as z.infer<typeof resolveIncidentSchema>;
      const { id } = req.params;

      const incident = await prisma.incident.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: { resolvedAt: new Date(resolvedAt) }
      });

      if (incident.count === 0) {
        return res.status(404).json({ message: "Incident not found" });
      }

      return res.json({ message: "Incident resolved" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
