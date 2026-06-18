import type { PrismaClient } from "@prisma/client";
import { findActiveGuardShift } from "../../lib/guardShiftActive";
import {
  admitPreApprovedVisitor,
} from "./visitor-state-manager";

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
 * Now uses centralized visitor state manager.
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

  try {
    // Use centralized state manager for OTP/QR admission
    const result = await db.$transaction(async (tx) => {
      return await admitPreApprovedVisitor(tx, {
        otpCode: p.otp,
        gateId: shift.gateId!,
        guardUserId: p.userId,
        societyId: p.societyId,
      });
    });

    return {
      status: 200,
      body: {
        admitted: true,
        verified: true,
        visitor: result.visitor,
        preApproved: result.preApproved,
        message: "Pre-approved visitor admitted successfully",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    
    if (message === "PRE_APPROVED_NOT_FOUND") {
      return {
        status: 404,
        body: {
          admitted: false,
          verified: false,
          message: "OTP not found or invalid",
        },
      };
    }
    
    if (message === "PRE_APPROVED_EXHAUSTED") {
      return {
        status: 409,
        body: {
          admitted: false,
          verified: false,
          message: "Pre-approval has been used (max uses reached)",
        },
      };
    }
    
    if (message === "PRE_APPROVED_EXPIRED") {
      return {
        status: 400,
        body: {
          admitted: false,
          verified: false,
          message: "Pre-approval has expired",
        },
      };
    }

    // Villa has no unit/occupant configured — same condition the walk-in path
    // returns as a clean 400 (was previously falling through to a 500).
    if (message === "NO_UNIT_FOUND_FOR_VILLA" || message === "NO_OCCUPANT_UNIT") {
      return {
        status: 400,
        body: {
          admitted: false,
          verified: false,
          message:
            "No unit/occupant is set up for this villa. Link a resident to a unit before admitting visitors.",
        },
      };
    }

    if (message === "PRE_APPROVED_IDENTIFIER_REQUIRED") {
      return {
        status: 400,
        body: {
          admitted: false,
          verified: false,
          message: "An OTP or pre-approval reference is required.",
        },
      };
    }

    throw err;
  }
}

/**
 * Same check-in as [runVisitorApproveEntry], but resolves the pre-approval row by id
 * (no OTP typing at gate — guard picks the row from the society list).
 * Now uses centralized visitor state manager.
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

  try {
    // Use centralized state manager for pre-approved admission by ID
    const result = await db.$transaction(async (tx) => {
      return await admitPreApprovedVisitor(tx, {
        preApprovedId: p.preApprovedId,
        gateId: shift.gateId!,
        guardUserId: p.userId,
        societyId: p.societyId,
      });
    });

    return {
      status: 200,
      body: {
        admitted: true,
        verified: true,
        visitor: result.visitor,
        preApproved: result.preApproved,
        message: "Pre-approved visitor admitted successfully",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    
    if (message === "PRE_APPROVED_NOT_FOUND") {
      return {
        status: 404,
        body: {
          admitted: false,
          verified: false,
          message: "Pre-approval not found",
        },
      };
    }
    
    if (message === "PRE_APPROVED_EXHAUSTED") {
      return {
        status: 409,
        body: {
          admitted: false,
          verified: false,
          message: "Pre-approval has been used (max uses reached)",
        },
      };
    }
    
    if (message === "PRE_APPROVED_EXPIRED") {
      return {
        status: 400,
        body: {
          admitted: false,
          verified: false,
          message: "Pre-approval has expired",
        },
      };
    }

    // Villa has no unit/occupant configured — same condition the walk-in path
    // returns as a clean 400 (was previously falling through to a 500).
    if (message === "NO_UNIT_FOUND_FOR_VILLA" || message === "NO_OCCUPANT_UNIT") {
      return {
        status: 400,
        body: {
          admitted: false,
          verified: false,
          message:
            "No unit/occupant is set up for this villa. Link a resident to a unit before admitting visitors.",
        },
      };
    }

    if (message === "PRE_APPROVED_IDENTIFIER_REQUIRED") {
      return {
        status: 400,
        body: {
          admitted: false,
          verified: false,
          message: "An OTP or pre-approval reference is required.",
        },
      };
    }

    throw err;
  }
}
