import type { PrismaClient } from "@prisma/client";
import { findActiveGuardShift } from "../../lib/guardShiftActive";
import {
  ensureBillingAccountForProperty,
  getPreferredUnitIdForVilla,
} from "../../lib/propertyInfrastructure";

export const OTP_ALREADY_CONSUMED = "OTP_ALREADY_CONSUMED";
export const NO_OCCUPANT_UNIT = "NO_OCCUPANT_UNIT";

export type VisitorApproveEntryParams = {
  userId: string;
  societyId: string;
  otp: string;
  villaId: string;
  visitorName?: string;
  visitorPhone?: string;
  purpose?: string;
  vehicleNumber?: string;
  /** Defaults to `new Date()` */
  now?: Date;
};

export type VisitorApproveEntryHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Atomic OTP consume + visitor check-in (used by POST /guards/visitor-approve-entry).
 */
export async function runVisitorApproveEntry(
  db: PrismaClient,
  p: VisitorApproveEntryParams,
): Promise<VisitorApproveEntryHttpResult> {
  const now = p.now ?? new Date();

  const shift = await findActiveGuardShift(db, {
    guardId: p.userId,
    societyId: p.societyId,
    now,
  });

  if (!shift) {
    return { status: 400, body: { message: "No active shift found" } };
  }

  const preApproved = await db.preApprovedVisitor.findFirst({
    where: { societyId: p.societyId, villaId: p.villaId, otp: p.otp, isActive: true },
  });

  if (!preApproved) {
    return {
      status: 404,
      body: {
        admitted: false,
        verified: false,
        message: "OTP not found",
      },
    };
  }

  if (preApproved.isUsed) {
    return {
      status: 409,
      body: {
        admitted: false,
        verified: false,
        message: "OTP already used",
      },
    };
  }

  if (preApproved.validUntil && new Date(preApproved.validUntil) < now) {
    return {
      status: 400,
      body: {
        admitted: false,
        verified: false,
        message: "OTP expired",
      },
    };
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const consume = await tx.preApprovedVisitor.updateMany({
        where: {
          id: preApproved.id,
          isUsed: false,
          isActive: true,
        },
        data: { isUsed: true, usedAt: now },
      });
      if (consume.count !== 1) {
        throw new Error(OTP_ALREADY_CONSUMED);
      }

      const visitor = await tx.visitor.create({
        data: {
          societyId: p.societyId,
          gateId: shift.gateId,
          name: (p.visitorName || preApproved.name || "").trim(),
          phone: (p.visitorPhone || preApproved.phone || "").trim(),
          visitorType: preApproved.visitorType,
          purpose: (p.purpose || preApproved.purpose || "Pre-approved visitor").trim(),
          vehicleNumber: p.vehicleNumber?.trim() || null,
          checkInTime: now,
          status: "CHECKED_IN",
          createdBy: p.userId,
        },
      });

      await ensureBillingAccountForProperty(tx, {
        societyId: p.societyId,
        villaId: p.villaId,
      });
      const defaultUnitId = await getPreferredUnitIdForVilla(tx, {
        societyId: p.societyId,
        villaId: p.villaId,
      });
      if (!defaultUnitId) {
        throw new Error(NO_OCCUPANT_UNIT);
      }
      await tx.visitorVilla.create({
        data: {
          visitorId: visitor.id,
          villaId: p.villaId,
          unitId: defaultUnitId,
          notifiedAt: now,
          notes: "Admitted via OTP approval flow",
        },
      });

      const hydrated = await tx.visitor.findUnique({
        where: { id: visitor.id },
        include: {
          villaVisits: {
            include: {
              villa: { select: { id: true, villaNumber: true, block: true } },
            },
          },
          gate: { select: { id: true, name: true } },
        },
      });

      return hydrated;
    });

    return {
      status: 201,
      body: {
        admitted: true,
        verified: true,
        message: "Visitor admitted and checked in",
        visitor: result,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message === OTP_ALREADY_CONSUMED) {
      return {
        status: 409,
        body: {
          admitted: false,
          verified: false,
          message: "OTP already used",
        },
      };
    }
    if (error instanceof Error && error.message === NO_OCCUPANT_UNIT) {
      return {
        status: 400,
        body: {
          admitted: false,
          verified: false,
          message:
            "This property has no occupant units. Ask the admin to add at least one unit (e.g. Ground floor / First floor) on the villa.",
        },
      };
    }
    throw error;
  }
}

/**
 * Same check-in as [runVisitorApproveEntry], but resolves the pre-approval row by id
 * (no OTP typing at gate — guard picks the row from the society list).
 */
export async function runVisitorAdmitPreApprovedById(
  db: PrismaClient,
  p: { userId: string; societyId: string; preApprovedId: string; now?: Date },
): Promise<VisitorApproveEntryHttpResult> {
  const now = p.now ?? new Date();

  const shift = await findActiveGuardShift(db, {
    guardId: p.userId,
    societyId: p.societyId,
    now,
  });

  if (!shift) {
    return { status: 400, body: { message: "No active shift found" } };
  }

  const preApproved = await db.preApprovedVisitor.findFirst({
    where: {
      id: p.preApprovedId,
      societyId: p.societyId,
      isActive: true,
    },
  });

  if (!preApproved) {
    return {
      status: 404,
      body: {
        admitted: false,
        verified: false,
        message: "Pre-approval not found",
      },
    };
  }

  if (preApproved.isUsed) {
    return {
      status: 409,
      body: {
        admitted: false,
        verified: false,
        message: "This visitor was already admitted",
      },
    };
  }

  if (preApproved.validUntil && new Date(preApproved.validUntil) < now) {
    return {
      status: 400,
      body: {
        admitted: false,
        verified: false,
        message: "Pre-approval expired",
      },
    };
  }

  const villaId = preApproved.villaId;

  try {
    const result = await db.$transaction(async (tx) => {
      const consume = await tx.preApprovedVisitor.updateMany({
        where: {
          id: preApproved.id,
          isUsed: false,
          isActive: true,
        },
        data: { isUsed: true, usedAt: now },
      });
      if (consume.count !== 1) {
        throw new Error(OTP_ALREADY_CONSUMED);
      }

      const visitor = await tx.visitor.create({
        data: {
          societyId: p.societyId,
          gateId: shift.gateId,
          name: preApproved.name.trim(),
          phone: preApproved.phone.trim(),
          visitorType: preApproved.visitorType,
          purpose: (preApproved.purpose || "Pre-approved visitor").trim(),
          vehicleNumber: null,
          checkInTime: now,
          status: "CHECKED_IN",
          createdBy: p.userId,
        },
      });

      await ensureBillingAccountForProperty(tx, {
        societyId: p.societyId,
        villaId,
      });
      const defaultUnitId = await getPreferredUnitIdForVilla(tx, {
        societyId: p.societyId,
        villaId,
      });
      if (!defaultUnitId) {
        throw new Error(NO_OCCUPANT_UNIT);
      }
      await tx.visitorVilla.create({
        data: {
          visitorId: visitor.id,
          villaId,
          unitId: defaultUnitId,
          notifiedAt: now,
          notes: "Admitted from guard pre-approved list",
        },
      });

      const hydrated = await tx.visitor.findUnique({
        where: { id: visitor.id },
        include: {
          villaVisits: {
            include: {
              villa: { select: { id: true, villaNumber: true, block: true } },
            },
          },
          gate: { select: { id: true, name: true } },
        },
      });

      return hydrated;
    });

    return {
      status: 201,
      body: {
        admitted: true,
        verified: true,
        message: "Visitor admitted and checked in",
        visitor: result,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message === OTP_ALREADY_CONSUMED) {
      return {
        status: 409,
        body: {
          admitted: false,
          verified: false,
          message: "This visitor was already admitted",
        },
      };
    }
    if (error instanceof Error && error.message === NO_OCCUPANT_UNIT) {
      return {
        status: 400,
        body: {
          admitted: false,
          verified: false,
          message:
            "This property has no occupant units. Ask the admin to add at least one unit on the villa.",
        },
      };
    }
    throw error;
  }
}
