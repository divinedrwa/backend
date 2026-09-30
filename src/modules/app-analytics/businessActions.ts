import type { Prisma } from "@prisma/client";
import { BillingPaymentSource, BillingUserPaymentStatus, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";

type Db = typeof prisma | Prisma.TransactionClient;

/** What residents and guards actually did in a period — counted from the real tables. */
export type BusinessActionCounts = {
  /** Flats with at least one active resident (adoption denominator). */
  occupiedFlats: number;
  preApprovals: number;
  preApprovalFlats: number;
  gateRequests: number;
  gateRequestsAnsweredInApp: number;
  onlinePayments: number;
  onlinePaymentFlats: number;
  complaints: number;
  gateEntries: number;
  parcels: number;
};

export async function getBusinessActionCounts(
  db: Db,
  societyId: string,
  from: Date,
  to: Date = new Date(),
): Promise<BusinessActionCounts> {
  const range = { gte: from, lt: to };
  const [
    occupied,
    preApprovals,
    gateRequestFlats,
    onlinePayments,
    complaints,
    gateEntries,
    parcels,
  ] = await Promise.all([
    db.user.findMany({
      where: {
        societyId,
        isActive: true,
        villaId: { not: null },
        role: { in: [UserRole.RESIDENT, UserRole.RESIDENT_CUM_ADMIN, UserRole.ADMIN] },
      },
      select: { villaId: true },
      distinct: ["villaId"],
    }),
    db.preApprovedVisitor.findMany({
      where: { villa: { societyId }, createdAt: range },
      select: { villaId: true },
    }),
    // Every flat asked to approve a walk-in, and whether a resident answered in the app.
    db.visitorVilla.findMany({
      where: { visitor: { societyId, createdAt: range }, notifiedAt: { not: null } },
      select: { respondedAt: true },
    }),
    db.userCyclePayment.findMany({
      where: {
        paymentStatus: BillingUserPaymentStatus.SUCCESS,
        source: BillingPaymentSource.GATEWAY,
        paidAt: range,
        user: { societyId },
      },
      select: { user: { select: { villaId: true } } },
    }),
    db.complaint.count({ where: { societyId, createdAt: range } }),
    db.visitor.count({
      where: { societyId, checkInAt: range, status: { in: ["CHECKED_IN", "CHECKED_OUT"] } },
    }),
    db.parcel.count({ where: { societyId, receivedAt: range } }),
  ]);

  return {
    occupiedFlats: occupied.length,
    preApprovals: preApprovals.length,
    preApprovalFlats: new Set(preApprovals.map((p) => p.villaId)).size,
    gateRequests: gateRequestFlats.length,
    gateRequestsAnsweredInApp: gateRequestFlats.filter((r) => r.respondedAt != null).length,
    onlinePayments: onlinePayments.length,
    onlinePaymentFlats: new Set(onlinePayments.map((p) => p.user?.villaId).filter(Boolean)).size,
    complaints,
    gateEntries,
    parcels,
  };
}
