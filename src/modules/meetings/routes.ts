import { MeetingStatus, MeetingType, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createSchema = z.object({
  title: z.string().trim().min(2).max(300),
  type: z.nativeEnum(MeetingType).optional().default("GENERAL"),
  scheduledAt: z.string().pipe(z.coerce.date()),
  location: z.string().max(300).optional(),
  agenda: z.string().max(10000).optional(),
  documentUrl: z.string().url().optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(2).max(300).optional(),
  type: z.nativeEnum(MeetingType).optional(),
  status: z.nativeEnum(MeetingStatus).optional(),
  scheduledAt: z.string().pipe(z.coerce.date()).optional(),
  endedAt: z.string().pipe(z.coerce.date()).optional().nullable(),
  location: z.string().max(300).optional().nullable(),
  agenda: z.string().max(10000).optional().nullable(),
  minutes: z.string().max(50000).optional().nullable(),
  attendeeCount: z.number().int().min(0).optional().nullable(),
  documentUrl: z.string().url().optional().nullable(),
});

router.use(requireAuth);

// All authenticated users can view meetings
router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const type = req.query.type as MeetingType | undefined;
    const status = req.query.status as MeetingStatus | undefined;

    const where = {
      societyId: req.auth!.societyId,
      ...(type && { type }),
      ...(status && { status }),
    };

    const [meetings, total] = await Promise.all([
      prisma.meeting.findMany({
        where,
        include: {
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { scheduledAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.meeting.count({ where }),
    ]);

    return res.json({ meetings, ...paginationMeta(total, meetings.length, pagination) });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const meeting = await prisma.meeting.findFirst({
      where: { id: req.params.id, societyId: req.auth!.societyId },
      include: {
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    return res.json({ meeting });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createSchema>;
      const meeting = await prisma.meeting.create({
        data: {
          societyId: req.auth!.societyId,
          title: body.title,
          type: body.type,
          scheduledAt: body.scheduledAt,
          location: body.location ?? null,
          agenda: body.agenda ?? null,
          documentUrl: body.documentUrl ?? null,
          createdById: req.auth!.userId,
        },
        include: {
          createdBy: { select: { id: true, name: true } },
        },
      });
      return res.status(201).json({ meeting });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updateSchema>;
      const existing = await prisma.meeting.findFirst({
        where: { id: req.params.id, societyId: req.auth!.societyId },
      });
      if (!existing) return res.status(404).json({ message: "Meeting not found" });

      const meeting = await prisma.meeting.update({
        where: { id: req.params.id },
        data: {
          ...(body.title !== undefined && { title: body.title }),
          ...(body.type !== undefined && { type: body.type }),
          ...(body.status !== undefined && { status: body.status }),
          ...(body.scheduledAt !== undefined && { scheduledAt: body.scheduledAt }),
          ...(body.endedAt !== undefined && { endedAt: body.endedAt }),
          ...(body.location !== undefined && { location: body.location }),
          ...(body.agenda !== undefined && { agenda: body.agenda }),
          ...(body.minutes !== undefined && { minutes: body.minutes }),
          ...(body.attendeeCount !== undefined && { attendeeCount: body.attendeeCount }),
          ...(body.documentUrl !== undefined && { documentUrl: body.documentUrl }),
        },
        include: {
          createdBy: { select: { id: true, name: true } },
        },
      });
      return res.json({ message: "Meeting updated", meeting });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/:id",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const result = await prisma.meeting.deleteMany({
        where: { id: req.params.id, societyId: req.auth!.societyId },
      });
      if (result.count === 0) return res.status(404).json({ message: "Meeting not found" });
      return res.json({ message: "Meeting deleted" });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
