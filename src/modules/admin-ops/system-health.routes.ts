import { Router } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { isFirebaseConfigured } from "../../services/notification.service";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

/**
 * GET /api/admin-ops/system-health
 * F1 — consolidated ops snapshot for admin self-diagnosis.
 */
router.get("/system-health", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const [
      unresolvedAlerts,
      criticalAlerts,
      lastGatewayLog,
      lastReconciliationTouch,
      pushDevices,
      usersWithDevice,
      notifications24h,
      recentMaintenancePayments,
    ] = await Promise.all([
      prisma.reconciliationAlert.count({
        where: { societyId, resolvedAt: null },
      }),
      prisma.reconciliationAlert.count({
        where: { societyId, resolvedAt: null, severity: "CRITICAL" },
      }),
      prisma.billingPaymentLog.findFirst({
        where: { societyId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          cycleId: true,
          userId: true,
        },
      }),
      prisma.reconciliationAlert.findFirst({
        where: { societyId },
        orderBy: { detectedAt: "desc" },
        select: { detectedAt: true, resolvedAt: true, severity: true },
      }),
      prisma.pushDevice.count({
        where: { user: { societyId, isActive: true } },
      }),
      prisma.pushDevice.findMany({
        where: { user: { societyId } },
        select: { userId: true },
        distinct: ["userId"],
      }),
      prisma.userNotification.count({
        where: {
          societyId,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      prisma.maintenancePayment.count({
        where: {
          societyId,
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    const financialStatus =
      criticalAlerts > 0 ? "CRITICAL" : unresolvedAlerts > 0 ? "WARNING" : "HEALTHY";

    return res.json({
      api: { ok: true, checkedAt: new Date().toISOString() },
      reconciliation: {
        status: financialStatus,
        unresolvedAlerts,
        criticalAlerts,
        lastActivityAt: lastReconciliationTouch?.detectedAt ?? null,
        lastSeverity: lastReconciliationTouch?.severity ?? null,
      },
      gateway: {
        lastPaymentLog: lastGatewayLog
          ? {
              id: lastGatewayLog.id,
              status: lastGatewayLog.status,
              at: lastGatewayLog.createdAt,
              cycleId: lastGatewayLog.cycleId,
            }
          : null,
        webhookEndpoint: "/api/v1/payments/webhook",
      },
      push: {
        firebaseConfigured: isFirebaseConfigured(),
        registeredDevices: pushDevices,
        usersWithAtLeastOneDevice: usersWithDevice.length,
        notificationsCreatedLast24h: notifications24h,
      },
      maintenance: {
        paymentsRecordedLast7Days: recentMaintenancePayments,
      },
    });
  } catch (e) {
    next(e);
  }
});

/** F2 — Payment order timeline for admin debugging. */
router.get("/payment-timeline", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const transactionId = String(req.query.transactionId ?? req.query.orderId ?? "").trim();
    if (!transactionId) {
      return res.status(400).json({ message: "transactionId or orderId required" });
    }

    const recentLogs = await prisma.billingPaymentLog.findMany({
      where: { societyId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const logs = recentLogs.filter((l) => {
      const blob = JSON.stringify(l.requestPayload ?? {}) + JSON.stringify(l.responsePayload ?? {});
      return blob.includes(transactionId);
    }).reverse();

    const maintenancePayments = await prisma.maintenancePayment.findMany({
      where: {
        societyId,
        OR: [
          { transactionId },
          { receiptNumber: { contains: transactionId.slice(0, 12) } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 10,
      select: {
        id: true,
        amount: true,
        paymentMode: true,
        paymentDate: true,
        receiptNumber: true,
        createdAt: true,
      },
    });

    const events = [
      ...logs.map((l) => ({
        at: l.createdAt,
        kind: "gateway_log" as const,
        status: l.status,
        detail: l.responsePayload,
      })),
      ...maintenancePayments.map((p) => ({
        at: p.createdAt,
        kind: "maintenance_payment" as const,
        status: p.paymentMode,
        detail: { amount: p.amount, receiptNumber: p.receiptNumber },
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

    return res.json({ transactionId, events });
  } catch (e) {
    next(e);
  }
});

/** F3 — In-app runbook index (ops troubleshooting). */
router.get("/runbooks", async (_req, res) => {
  return res.json({
    runbooks: [
      {
        id: "payment-pending",
        title: "Payment stuck on verifying",
        summary:
          "Resident paid but app shows confirming. Check gateway poll, webhook delivery, and ledger sync.",
        docPath: "backend/docs/GATEWAY_PAYMENT_TROUBLESHOOTING.md",
        steps: [
          "Open System health → last gateway log",
          "Use Payment timeline with order/transaction id",
          "Run GET /v1/payments/razorpay/status/:orderId or phonepe status",
          "If ledgerSynced false, check reconciliation alerts",
        ],
      },
      {
        id: "reconciliation-alert",
        title: "Reconciliation CRITICAL alert",
        summary: "Villa settled total does not match cash received for a cycle.",
        steps: [
          "Open Reconciliation → review Credit vs Cash columns",
          "Re-run reconciliation (hourly cron auto-heals stale alerts)",
          "If credit-settled, alert should auto-resolve",
          "If excess cash, investigate duplicate mark-paid (A4)",
        ],
      },
      {
        id: "push-not-received",
        title: "Push notification not received",
        summary: "FCM delivery or device registration issue.",
        steps: [
          "System health → Send test push to yourself",
          "Confirm Firebase configured and device registered on login",
          "Check resident notification preferences (non-critical may be muted)",
        ],
      },
    ],
  });
});

export default router;
