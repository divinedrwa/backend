/**
 * FINANCIAL RECONCILIATION ALERTS
 * 
 * Admin endpoint to view and resolve ledger mismatches.
 */

import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { Prisma, UserRole } from "@prisma/client";

const router = Router();

// GET /api/reconciliation/alerts - List all alerts
router.get(
  "/alerts",
  requireAuth,
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const { status = 'unresolved' } = req.query;

      const whereClause: Prisma.ReconciliationAlertWhereInput = { societyId };
      if (status === 'unresolved') {
        whereClause.resolvedAt = null;
      } else if (status === 'resolved') {
        whereClause.resolvedAt = { not: null };
      }

      const pagination = getPagination(req);
      const [alerts, total, allAlerts] = await Promise.all([
        prisma.reconciliationAlert.findMany({
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
          take: pagination.take,
          skip: pagination.skip,
        }),
        prisma.reconciliationAlert.count({ where: whereClause }),
        // Fetch severity + difference for stats across all matching rows
        prisma.reconciliationAlert.findMany({
          where: whereClause,
          select: { severity: true, difference: true },
        }),
      ]);

      // Calculate stats across the full (unpaginated) result set
      const stats = {
        total,
        critical: allAlerts.filter(a => a.severity === 'CRITICAL').length,
        warning: allAlerts.filter(a => a.severity === 'WARNING').length,
        totalDifference: allAlerts.reduce((sum, a) => sum + Number(a.difference), 0),
      };

      return res.json({ alerts, stats, ...paginationMeta(total, alerts.length, pagination) });
    } catch (e) {
      next(e);
    }
  }
);

// POST /api/reconciliation/alerts/:id/resolve - Resolve an alert
const resolveSchema = z.object({
  notes: z.string().trim().min(1, "Resolution notes are required"),
});

router.post(
  "/alerts/:id/resolve",
  requireAuth,
  requireRole(UserRole.ADMIN),
  validateBody(resolveSchema),
  async (req, res, next) => {
    try {
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
    } catch (e) {
      next(e);
    }
  }
);

// GET /api/reconciliation/summary - Overall financial health summary
router.get(
  "/summary",
  requireAuth,
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const [unresolvedAlerts, criticalAlerts, warningAlerts, totalDifferenceAgg, recentPayments, totalCycles, activeCycles] =
        await Promise.all([
          prisma.reconciliationAlert.count({
            where: { societyId, resolvedAt: null },
          }),
          prisma.reconciliationAlert.count({
            where: { societyId, resolvedAt: null, severity: 'CRITICAL' },
          }),
          prisma.reconciliationAlert.count({
            where: { societyId, resolvedAt: null, severity: 'WARNING' },
          }),
          prisma.reconciliationAlert.aggregate({
            where: { societyId, resolvedAt: null },
            _sum: { difference: true },
          }),
          prisma.maintenancePayment.count({
            where: {
              societyId,
              createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            },
          }),
          prisma.maintenanceCollectionCycle.count({
            where: { societyId },
          }),
          prisma.maintenanceCollectionCycle.count({
            where: { societyId, createdAt: { gte: sixMonthsAgo } },
          }),
        ]);

      const healthStatus =
        criticalAlerts > 0 ? 'CRITICAL' : unresolvedAlerts > 0 ? 'WARNING' : 'HEALTHY';
      const totalDifference = Number(totalDifferenceAgg._sum.difference ?? 0);

      return res.json({
        financialHealth: {
          status: healthStatus,
          unresolvedAlerts,
          criticalAlerts,
          recentPayments7Days: recentPayments,
        },
        cycles: {
          total: totalCycles,
          active: activeCycles,
        },
        // Legacy flat shape — kept for deployed admin web until frontend v2 ships.
        healthStatus,
        criticalCount: criticalAlerts,
        warningCount: warningAlerts,
        totalDifference,
        recentPaymentsCount: recentPayments,
        totalCycles,
        activeCycles,
      });
    } catch (e) {
      next(e);
    }
  }
);

export default router;
