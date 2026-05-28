import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { UserRole, PatrolStatus, IncidentSeverity, VisitorStatus } from "@prisma/client";
import { findActiveGuardShift } from "../../lib/guardShiftActive";

const router = Router();

router.use(requireAuth);

// Validation schemas
const startPatrolSchema = z.object({
  location: z.string().trim().min(2),
  notes: z.string().trim().optional(),
});

const patrolCheckpointSchema = z.object({
  location: z.string().trim().min(2),
  notes: z.string().trim().optional(),
  issuesFound: z.boolean().optional(),
});

const createIncidentSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  location: z.string().trim().optional(),
});

// POST /api/guards/start-patrol - Start patrol
router.post("/start-patrol", requireRole(UserRole.GUARD), validateBody(startPatrolSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { location, notes } = req.body;

    // Try active shift gate first, then legacy assignedGate
    const activeShift = await findActiveGuardShift(prisma, {
      guardId: userId,
      societyId,
    });

    const guard = await prisma.user.findUnique({
      where: { id: userId },
      include: { assignedGate: true },
    });

    const gateId = activeShift?.gateId ?? guard?.assignedGate?.id;
    if (!gateId) {
      return res.status(400).json({ message: "No gate assigned to guard" });
    }

    const patrol = await prisma.guardPatrol.create({
      data: {
        societyId,
        guardId: userId,
        gateId,
        checkpointName: "Patrol Start",
        checkpointLocation: location,
        scheduledTime: new Date(),
        actualTime: new Date(),
        status: PatrolStatus.IN_PROGRESS,
        notes: notes || "Patrol started",
      },
    });

    return res.status(201).json({
      message: "Patrol started",
      patrol,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/guards/patrol-checkpoint - Log checkpoint
router.post("/patrol-checkpoint", requireRole(UserRole.GUARD), validateBody(patrolCheckpointSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { location, notes, issuesFound } = req.body;

    // Try active shift gate first, then legacy assignedGate
    const activeShift = await findActiveGuardShift(prisma, {
      guardId: userId,
      societyId,
    });

    const guard = await prisma.user.findUnique({
      where: { id: userId },
      include: { assignedGate: true },
    });

    const gateId = activeShift?.gateId ?? guard?.assignedGate?.id;
    if (!gateId) {
      return res.status(400).json({ message: "No gate assigned to guard" });
    }

    const checkpoint = await prisma.guardPatrol.create({
      data: {
        societyId,
        guardId: userId,
        gateId,
        checkpointName: location || "Checkpoint",
        checkpointLocation: location,
        scheduledTime: new Date(),
        actualTime: new Date(),
        status: PatrolStatus.COMPLETED,
        notes: notes || `Checkpoint: ${location}${issuesFound ? " (Issues found)" : ""}`,
      },
    });

    return res.status(201).json({
      message: "Checkpoint logged",
      checkpoint,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/my-patrols - Get my patrol history
router.get("/my-patrols", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { days = "7" } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days as string));

    const patrols = await prisma.guardPatrol.findMany({
      where: {
        guardId: userId,
        societyId,
        scheduledTime: { gte: startDate },
      },
      orderBy: { scheduledTime: "desc" },
    });

    // Group by date
    const byDate = patrols.reduce<Record<string, typeof patrols>>((acc, p) => {
      const date = new Date(p.scheduledTime).toDateString();
      if (!acc[date]) acc[date] = [];
      acc[date].push(p);
      return acc;
    }, {});

    return res.json({
      patrols,
      byDate,
      summary: {
        total: patrols.length,
        days: Object.keys(byDate).length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/patrols-today - Today's patrols
router.get("/patrols-today", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const patrols = await prisma.guardPatrol.findMany({
      where: {
        guardId: userId,
        societyId,
        scheduledTime: { gte: today, lt: tomorrow },
      },
      orderBy: { scheduledTime: "asc" },
    });

    return res.json({
      patrols,
      count: patrols.length,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/guards/create-incident - Report incident
router.post("/create-incident", requireRole(UserRole.GUARD), validateBody(createIncidentSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { title, description, location, severity } = req.body;

    const incident = await prisma.incident.create({
      data: {
        societyId,
        reportedBy: userId, // Correct field name
        title,
        description,
        location,
        severity: severity || IncidentSeverity.MEDIUM,
        // Note: No status or timestamp fields in Incident model
      },
    });

    return res.status(201).json({
      message: "Incident reported successfully",
      incident,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/checklist - Daily checklist
router.get("/checklist", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get today's completed tasks
    const [visitorsCheckedIn, parcelsLogged, patrolsCompleted, _incidentsReported] = await Promise.all([
      prisma.visitor.count({
        where: {
          societyId,
          checkInTime: { gte: today, lt: tomorrow },
        },
      }),
      prisma.parcel.count({
        where: {
          societyId,
          receivedAt: { gte: today, lt: tomorrow },
        },
      }),
      prisma.guardPatrol.count({
        where: {
          guardId: userId,
          societyId,
          scheduledTime: { gte: today, lt: tomorrow },
        },
      }),
      prisma.incident.count({
        where: {
          reportedBy: userId, // Correct field name
          societyId,
          createdAt: { gte: today, lt: tomorrow },
        },
      }),
    ]);

    // Get pending visitors
    const pendingCheckouts = await prisma.visitor.count({
      where: {
        societyId,
        status: "CHECKED_IN" as VisitorStatus,
        checkOutTime: null,
      },
    });

    // Checklist items
    const checklist = [
      {
        task: "Check-in visitors",
        completed: visitorsCheckedIn > 0,
        count: visitorsCheckedIn,
      },
      {
        task: "Log parcels",
        completed: parcelsLogged > 0,
        count: parcelsLogged,
      },
      {
        task: "Complete patrols",
        completed: patrolsCompleted >= 3, // Minimum 3 patrols expected
        count: patrolsCompleted,
        required: 3,
      },
      {
        task: "Check-out pending visitors",
        completed: pendingCheckouts === 0,
        count: pendingCheckouts,
      },
    ];

    const completedTasks = checklist.filter((item) => item.completed).length;

    return res.json({
      checklist,
      summary: {
        total: checklist.length,
        completed: completedTasks,
        pending: checklist.length - completedTasks,
        percentage: Math.round((completedTasks / checklist.length) * 100),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
