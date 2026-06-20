import { IncidentSeverity, Prisma, UserRole } from "@prisma/client";
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
});

const createIncidentSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10),
  severity: z.nativeEnum(IncidentSeverity),
  location: z.string().trim().optional(),
  photoUrl: z.string().url().optional()
});

const resolveIncidentSchema = z.object({
  resolvedAt: z.string().datetime()
});

router.use(requireAuth);

// List incidents (admin sees all, guard sees own)
router.get("/", requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const { search, severity } = req.query;
    const whereClause: Prisma.IncidentWhereInput = {
      societyId: req.auth!.societyId,
    };

    // Guards see only their own reports
    if (req.auth!.role === UserRole.GUARD) {
      whereClause.reportedBy = req.auth!.userId;
    }

    if (typeof search === "string" && search.trim()) {
      const term = search.trim();
      whereClause.OR = [
        { title: { contains: term, mode: "insensitive" } },
        { description: { contains: term, mode: "insensitive" } },
      ];
    }
    if (typeof severity === "string" && severity.trim()) {
      whereClause.severity = severity.trim() as IncidentSeverity;
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

// Update incident (admin)
const updateIncidentSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().min(10).optional(),
  severity: z.nativeEnum(IncidentSeverity).optional(),
  location: z.string().trim().optional(),
  photoUrl: z.string().url().optional(),
});

router.put(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateIncidentSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body as z.infer<typeof updateIncidentSchema>;

      const incident = await prisma.incident.updateMany({
        where: { id, societyId: req.auth!.societyId },
        data: {
          ...(body.title !== undefined && { title: body.title }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.severity !== undefined && { severity: body.severity }),
          ...(body.location !== undefined && { location: body.location }),
          ...(body.photoUrl !== undefined && { photoUrl: body.photoUrl }),
        },
      });

      if (incident.count === 0) {
        return res.status(404).json({ message: "Incident not found" });
      }

      return res.json({ message: "Incident updated" });
    } catch (error) {
      next(error);
    }
  }
);

// Delete incident (admin)
router.delete(
  "/:id",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const incident = await prisma.incident.deleteMany({
        where: { id, societyId: req.auth!.societyId },
      });

      if (incident.count === 0) {
        return res.status(404).json({ message: "Incident not found" });
      }

      return res.json({ message: "Incident deleted" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
