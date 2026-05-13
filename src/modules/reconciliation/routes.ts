/**
 * FINANCIAL RECONCILIATION ALERTS
 * 
 * Admin endpoint to view and resolve ledger mismatches.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { UserRole } from "@prisma/client";

const router = Router();

// GET /api/reconciliation/alerts - List all alerts
router.get(
  "/alerts",
  requireAuth,
  requireRole(UserRole.ADMIN),
  async (req, res) => {
    const { societyId } = req.auth!;
    const { status = 'unresolved' } = req.query;

    const whereClause: any = { societyId };
    if (status === 'unresolved') {
      whereClause.resolvedAt = null;
    } else if (status === 'resolved') {
      whereClause.resolvedAt = { not: null };
    }

    const alerts = await prisma.reconciliationAlert.findMany({
      where: whereClause,
      include: {
        cycle: {
          select: {
            title: true,
            periodMonth: true,
            periodYear: true,
          },
        },
      },
      orderBy: [
        { severity: 'desc' },
        { detectedAt: 'desc' },
      ],
    });

    // Calculate stats
    const stats = {
      total: alerts.length,
      critical: alerts.filter(a => a.severity === 'CRITICAL').length,
      warning: alerts.filter(a => a.severity === 'WARNING').length,
      totalDifference: alerts.reduce((sum, a) => sum + Number(a.difference), 0),
    };

    return res.json({ alerts, stats });
  }
);

// POST /api/reconciliation/alerts/:id/resolve - Resolve an alert
const resolveSchema = z.object({
  notes: z.string().min(1, "Resolution notes are required"),
});

router.post(
  "/alerts/:id/resolve",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(resolveSchema),
  async (req, res) => {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;
    const { notes } = req.body;

    const alert = await prisma.reconciliationAlert.findFirst({
      where: { id, societyId },
    });

    if (!alert) {
      return res.status(404).json({ message: "Alert not found" });
    }

    if (alert.resolvedAt) {
      return res.status(400).json({ message: "Alert already resolved" });
    }

    const updated = await prisma.reconciliationAlert.update({
      where: { id },
      data: {
        resolvedAt: new Date(),
        resolvedBy: userId,
        notes,
      },
    });

    return res.json({ alert: updated });
  }
);

// GET /api/reconciliation/summary - Overall financial health summary
router.get(
  "/summary",
  requireAuth,
  requireRole(UserRole.ADMIN),
  async (req, res) => {
    const { societyId } = req.auth!;

    const unresolvedAlerts = await prisma.reconciliationAlert.count({
      where: { societyId, resolvedAt: null },
    });

    const criticalAlerts = await prisma.reconciliationAlert.count({
      where: { societyId, resolvedAt: null, severity: 'CRITICAL' },
    });

    const recentPayments = await prisma.maintenancePayment.count({
      where: {
        societyId,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    });

    const totalCycles = await prisma.maintenanceCollectionCycle.count({
      where: { societyId },
    });

    // Count recent cycles (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const activeCycles = await prisma.maintenanceCollectionCycle.count({
      where: { 
        societyId,
        createdAt: { gte: sixMonthsAgo },
      },
    });

    return res.json({
      financialHealth: {
        status: criticalAlerts > 0 ? 'CRITICAL' : unresolvedAlerts > 0 ? 'WARNING' : 'HEALTHY',
        unresolvedAlerts,
        criticalAlerts,
        recentPayments7Days: recentPayments,
      },
      cycles: {
        total: totalCycles,
        active: activeCycles,
      },
    });
  }
);

export default router;
