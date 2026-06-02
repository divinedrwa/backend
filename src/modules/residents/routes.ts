import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { passwordSchema } from "../../lib/passwordSchema";
import { logger } from "../../lib/logger";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { profileImageMemory } from "../../lib/profileImageUpload";
import { getCachedMoneySnapshot } from "../../lib/societyFinance";
import {
  buildPendingDuesFromLedger,
  reconcileVillaLedgersForRecentCycles,
} from "../billing-cycle/services/resident-pending-dues";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { isCloudinaryConfigured, uploadProfileImageBuffer } from "../../services/cloudinaryProfile";
import { MaintenanceBillingRole, UserRole, SOSStatus } from "@prisma/client";

const updateProfileSchema = z.object({
  name: z.string().trim().min(2).optional(),
  phone: z.string().trim().optional(),
  email: z.string().trim().email().optional(),
  notifyEmail: z.boolean().optional(),
  notifyPush: z.boolean().optional(),
});

const updateFamilyMemberSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  relationship: z.string().trim().min(1).max(50).optional(),
  age: z.number().int().min(0).max(120).optional(),
  phone: z.string().trim().max(20).optional(),
  idProof: z.string().trim().max(200).optional(),
});

const router = Router();

const userMeResponseSelect = {
  id: true,
  societyId: true,
  username: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  residentType: true,
  notifyEmail: true,
  notifyPush: true,
  villaId: true,
  moveInDate: true,
  moveOutDate: true,
  isActive: true,
  maintenanceBillingRole: true,
  createdAt: true,
  photoUrl: true,
  unitId: true,
  villa: {
    select: {
      id: true,
      villaNumber: true,
      floors: true,
      area: true,
      block: true,
      ownerName: true,
      monthlyMaintenance: true,
    },
  },
  unit: {
    select: {
      id: true,
      unitCode: true,
      label: true,
      isDefault: true,
    },
  },
  society: {
    select: {
      id: true,
      name: true,
    },
  },
};

const RESIDENT_TYPE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  TENANT: "Tenant",
  FAMILY_MEMBER: "Family member",
};

function formatResidentMeResponse(user: Record<string, unknown>) {
  const villa = user.villa as
    | { villaNumber?: string | null; block?: string | null }
    | null
    | undefined;
  const unit = user.unit as { label?: string | null } | null | undefined;
  const parts = [villa?.block, villa?.villaNumber].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  const rt = typeof user.residentType === "string" ? user.residentType : "";
  return {
    ...user,
    linkedPropertyId: user.villaId,
    linkedUnitId: user.unitId,
    propertyDisplayName: parts.length ? parts.join(" · ") : null,
    unitDisplayName: unit?.label ?? null,
    occupantRoleLabel: RESIDENT_TYPE_LABEL[rt] ?? rt,
  };
}

function emptyToUndef(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function conditionalProfileImageUpload(req: Request, res: Response, next: NextFunction) {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    return profileImageMemory.single("image")(req, res, next);
  }
  next();
}

function conditionalValidateProfileJson(req: Request, res: Response, next: NextFunction) {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/json")) {
    return validateBody(updateProfileSchema)(req, res, next);
  }
  next();
}

// All routes require authentication
router.use(requireAuth);

// Validation schemas
const addFamilyMemberSchema = z.object({
  name: z.string().trim().min(2),
  relationship: z.string().trim().min(2),
  age: z.number().int().positive().optional(),
  phone: z.string().trim().optional(),
  idProof: z.string().trim().optional(),
});

const emergencyContactSchema = z.object({
  name: z.string().trim().min(2),
  relationship: z.string().trim().min(2),
  phone: z.string().trim().min(10),
  address: z.string().trim().optional(),
});

// ========================================
// DASHBOARD API
// ========================================

// GET /api/residents/dashboard - Get resident dashboard
router.get("/dashboard", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId, villaId } = req.auth!;

    // Get user with villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      include: {
        villa: {
          select: {
            id: true,
            villaNumber: true,
            ownerName: true,
            block: true,
            floors: true,
            monthlyMaintenance: true,
          },
        },
      },
    });

    const maintenanceBillingExcluded =
      user?.maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED;

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    let personalPendingCount = 0;
    let personalPendingAmount = 0;
    if (!maintenanceBillingExcluded && villaId) {
      await reconcileVillaLedgersForRecentCycles(societyId, villaId);
      const personalDues = await buildPendingDuesFromLedger(societyId, userId);
      personalPendingCount = personalDues.length;
      personalPendingAmount = personalDues.reduce((sum, row) => sum + row.remainingDue, 0);
    }

    // Run all independent counts + money snapshot in parallel.
    const [complaintCount, pendingParcels, upcomingBookings, money] = await Promise.all([
        // Total complaints filed by this resident.
        prisma.complaint.count({
          where: { societyId, residentId: userId },
        }),
        // Undelivered parcels.
        villaId
          ? prisma.parcel.count({
              where: {
                societyId,
                villaId,
                status: { in: ["RECEIVED", "PENDING"] },
              },
            })
          : 0,
        // Upcoming amenity bookings.
        prisma.amenityBooking.count({
          where: {
            societyId,
            residentId: userId,
            status: { in: ["CONFIRMED", "PENDING"] },
            startTime: { gte: now },
          },
        }),
        // Canonical society money snapshot.
        getCachedMoneySnapshot(prisma, societyId),
      ]);

    const mergedAllTimeInflow = money.additionalFundsAllTime;
    const mergedMonthInflow = money.additionalFundsForMonth(month, year);
    // Collection excludes advance credit (overpayments belong to individual
    // residents, not to the society's collection pool).  Advance credit only
    // surfaces in the "Balance in Bank" breakdown on the app.
    const allTimeCollected =
      money.maintenanceCashAllTime + mergedAllTimeInflow - money.totalAdvanceCredit;
    const allTimeSpent = money.expensesAllTime;
    const currentBalance = money.currentFundBalance;
    const monthCashReceived = money.maintenanceCashForMonth(month, year);
    const monthCollected = monthCashReceived + mergedMonthInflow;
    const monthSpent = money.expensesForMonth(month, year);
    const monthNet = monthCollected - monthSpent;

    // Pending dues: gross outstanding per (villa, cycle) — NOT netted against
    // overpayments.  Villa A's advance credit belongs to Villa A, it doesn't
    // reduce what Villa B still owes.
    const pendingDues = money.outstandingDues;
    // Projected balance: what the fund would be if every pending due is paid.
    const projectedBalance = currentBalance + pendingDues;
    // Collection rate (0–100) based on capped collected vs expected.
    const collectedForRate = money.expectedAllTime - money.outstandingDues;
    const collectionRate =
      money.expectedAllTime > 0
        ? Math.min(100, (collectedForRate / money.expectedAllTime) * 100)
        : 0;

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      user: {
        name: user?.name,
        email: user?.email,
        phone: user?.phone,
        villa: user?.villa,
      },
      stats: {
        pendingMaintenance: personalPendingCount,
        personalPendingAmount,
        activeComplaints: complaintCount,
        totalComplaints: complaintCount,
        pendingParcels,
        upcomingBookings,
      },
      fund: {
        currentBalance,
        allTimeCollected,
        allTimeSpent,
        month,
        year,
        monthCollected,
        monthSpent,
        monthNet,
        maintenanceCollected: monthCashReceived,
        additionalMergedInflowMonth: mergedMonthInflow,
        additionalMergedInflowAllTime: mergedAllTimeInflow,
        totalAdvanceCredit: money.totalAdvanceCredit,
        expectedAllTime: money.expectedAllTime,
        pendingDues,
        projectedBalance,
        collectionRate: Math.round(collectionRate * 10) / 10,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    next(error);
  }
});

// ========================================
// PROFILE APIs
// ========================================

/** JSON or multipart `PATCH`/`PUT` /me — optional `image` is uploaded to Cloudinary; URL stored in `photoUrl`. */
async function updateResidentProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, societyId } = req.auth!;
    const contentType = req.headers["content-type"] || "";

    let name: string | undefined;
    let phone: string | undefined;
    let email: string | undefined;
    let notifyEmail: boolean | undefined;
    let notifyPush: boolean | undefined;

    if (contentType.includes("multipart/form-data")) {
      const parsed = updateProfileSchema.safeParse({
        name: emptyToUndef(req.body.name),
        phone: emptyToUndef(req.body.phone),
        email: emptyToUndef(req.body.email),
        notifyEmail:
          typeof req.body.notifyEmail === "boolean"
            ? req.body.notifyEmail
            : req.body.notifyEmail === "true"
              ? true
              : req.body.notifyEmail === "false"
                ? false
                : undefined,
        notifyPush:
          typeof req.body.notifyPush === "boolean"
            ? req.body.notifyPush
            : req.body.notifyPush === "true"
              ? true
              : req.body.notifyPush === "false"
                ? false
                : undefined,
      });
      if (!parsed.success) {
        return res.status(400).json({
          message: "Validation failed",
          issues: parsed.error.flatten(),
        });
      }
      ({ name, phone, email, notifyEmail, notifyPush } = parsed.data);
    } else {
      const b = req.body as z.infer<typeof updateProfileSchema>;
      name = b.name;
      phone = b.phone;
      email = b.email;
      notifyEmail = b.notifyEmail;
      notifyPush = b.notifyPush;
    }

    let photoUrl: string | undefined;
    const file = req.file;
    if (file?.buffer) {
      if (!isCloudinaryConfigured()) {
        return res.status(503).json({
          message:
            "Profile photo upload is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.",
        });
      }
      try {
        photoUrl = await uploadProfileImageBuffer(
          file.buffer,
          `profile_${userId}_${Date.now()}`
        );
      } catch (e) {
        logger.error({ err: e }, "[cloudinary] profile upload failed");
        return res.status(502).json({ message: "Could not upload image. Try again." });
      }
    }

    const hasText =
      (name !== undefined && name !== "") ||
      phone !== undefined ||
      (email !== undefined && email !== "") ||
      notifyEmail !== undefined ||
      notifyPush !== undefined;
    if (!hasText && !photoUrl) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    const user = await prisma.user.update({
      where: { id: userId, societyId },
      data: {
        ...(name !== undefined && name !== "" && { name }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && email !== "" && { email }),
        ...(notifyEmail !== undefined && { notifyEmail }),
        ...(notifyPush !== undefined && { notifyPush }),
        ...(photoUrl && { photoUrl }),
      },
      select: userMeResponseSelect,
    });

    return res.json({
      message: "Profile updated successfully",
      user: formatResidentMeResponse(user as Record<string, unknown>),
    });
  } catch (error) {
    next(error);
  }
}

// GET /api/residents/me - Get my profile
router.get("/me", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: userMeResponseSelect,
    });

    if (!user) {
      return res.status(404).json({ message: "Profile not found" });
    }

    return res.json({ user: formatResidentMeResponse(user as Record<string, unknown>) });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/residents/me — JSON or multipart (`image` → Cloudinary; same request as text fields)
router.patch(
  "/me",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  conditionalProfileImageUpload,
  conditionalValidateProfileJson,
  updateResidentProfile
);

// PUT /api/residents/me — same as PATCH (Flutter fallback)
router.put(
  "/me",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  conditionalProfileImageUpload,
  conditionalValidateProfileJson,
  updateResidentProfile
);

// DELETE /api/residents/me — two modes:
//
//   • Default (no query)                      → soft-deactivate (legacy)
//     `isActive=false`, push devices off, row + PII retained so an admin can
//     restore access if the resident changes their mind.
//
//   • `?confirmHardDelete=<full name>`        → real account deletion
//     Required for Apple App Store guideline 5.1.1(v) and Google Play's User
//     Data policy: users must be able to delete their account from inside
//     the app. We anonymize-in-place rather than `prisma.user.delete()` so
//     financial / audit history stays referentially valid; all personal
//     identifiers (name, email, phone, photo, password, biometric tokens)
//     are scrubbed and credentials randomised so the user can never sign in
//     again. The typed-name guard mirrors the super-admin society hard-delete
//     pattern and prevents accidental destructive taps.
router.delete("/me", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const existing = await prisma.user.findFirst({
      where: { id: userId, societyId, role: { in: [UserRole.RESIDENT, UserRole.RESIDENT_CUM_ADMIN] } },
      select: { id: true, isActive: true, name: true },
    });

    if (!existing) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const confirmHardDelete = (
      typeof req.query.confirmHardDelete === "string"
        ? req.query.confirmHardDelete
        : ""
    ).trim();

    if (confirmHardDelete) {
      if (
        confirmHardDelete.toLowerCase() !==
        existing.name.trim().toLowerCase()
      ) {
        return res.status(400).json({
          message:
            "confirmHardDelete must equal your full name exactly (case-insensitive).",
        });
      }

      const token = randomBytes(16).toString("hex");
      const scrubbedEmail = `deleted+${token}@deleted.local`;
      const scrubbedUsername = `deleted_${token}`;
      const unguessableHash = await bcrypt.hash(
        randomBytes(32).toString("hex"),
        10
      );

      await prisma.$transaction([
        prisma.familyMember.deleteMany({ where: { residentId: userId } }),
        prisma.emergencyContact.deleteMany({ where: { residentId: userId } }),
        prisma.pushDevice.updateMany({
          where: { userId },
          data: { isActive: false },
        }),
        prisma.user.update({
          where: { id: userId },
          data: {
            isActive: false,
            moveOutDate: new Date(),
            name: "Deleted user",
            email: scrubbedEmail,
            username: scrubbedUsername,
            phone: null,
            photoUrl: null,
            passwordHash: unguessableHash,
            notifyEmail: false,
          },
        }),
      ]);

      return res.json({
        ok: true,
        mode: "hard_deleted",
        message:
          "Account deleted. Your personal information has been removed; financial and audit records are retained for the society's accounting requirements.",
      });
    }

    // Default soft-deactivate path (backward compatible).
    if (!existing.isActive) {
      return res.status(400).json({ message: "Account is already deactivated" });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          isActive: false,
          moveOutDate: new Date(),
        },
      }),
      prisma.pushDevice.updateMany({
        where: { userId },
        data: { isActive: false },
      }),
    ]);

    return res.json({
      ok: true,
      mode: "deactivated",
      message:
        "Your account has been deactivated. Data is retained for society records; contact admin to restore access.",
      deactivated: true,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/my-villa - Get my villa details
router.get("/my-villa", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const villa = await prisma.villa.findFirst({
      where: { id: user.villaId, societyId },
      include: {
        users: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            residentType: true,
            moveInDate: true,
          },
        },
        _count: {
          select: {
            maintenance: { where: { status: "PENDING" } },
            vehicles: true,
            staffAssignments: { where: { isActive: true } },
          },
        },
      },
    });

    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    return res.json({ villa });
  } catch (error) {
    next(error);
  }
});

// ========================================
// FAMILY MANAGEMENT APIs
// ========================================

// GET /api/residents/my-family - Get family members
router.get("/my-family", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId } = req.auth!;

    const raw = await prisma.familyMember.findMany({
      where: { residentId: userId },
      orderBy: { createdAt: "desc" },
    });

    const familyMembers = raw.map((m) => ({
      id: m.id,
      name: m.name,
      relationship: m.relation,
      age: m.age,
      phone: m.phone,
      idProof: m.idProof,
      createdAt: m.createdAt,
    }));

    return res.json({ familyMembers, count: familyMembers.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/add-family-member - Add family member
router.post("/add-family-member", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(addFamilyMemberSchema), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { name, relationship, age, phone, idProof } = req.body;

    const created = await prisma.familyMember.create({
      data: {
        residentId: userId,
        name,
        relation: relationship,
        relationship,
        age,
        phone,
        idProof,
      },
    });

    return res.status(201).json({
      message: "Family member added successfully",
      familyMember: {
        id: created.id,
        name: created.name,
        relationship: created.relation,
        age: created.age,
        phone: created.phone,
        idProof: created.idProof,
        createdAt: created.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/residents/family/:id - Update family member
router.patch("/family/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(updateFamilyMemberSchema), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { id } = req.params;
    const body = req.body as z.infer<typeof updateFamilyMemberSchema>;

    // Verify ownership
    const existing = await prisma.familyMember.findFirst({
      where: { id, residentId: userId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Family member not found" });
    }

    const updated = await prisma.familyMember.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.relationship !== undefined && { relation: body.relationship, relationship: body.relationship }),
        ...(body.age !== undefined && { age: body.age }),
        ...(body.phone !== undefined && { phone: body.phone }),
        ...(body.idProof !== undefined && { idProof: body.idProof }),
      },
    });

    return res.json({
      message: "Family member updated successfully",
      familyMember: {
        id: updated.id,
        name: updated.name,
        relationship: updated.relation,
        age: updated.age,
        phone: updated.phone,
        idProof: updated.idProof,
        createdAt: updated.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/residents/family/:id - Remove family member
router.delete("/family/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { id } = req.params;

    // Verify ownership
    const existing = await prisma.familyMember.findFirst({
      where: { id, residentId: userId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Family member not found" });
    }

    await prisma.familyMember.delete({ where: { id } });

    return res.json({ message: "Family member removed successfully" });
  } catch (error) {
    next(error);
  }
});

// ========================================
// EMERGENCY CONTACTS APIs
// ========================================

// GET /api/residents/security-contacts - Active guard contacts for resident society
router.get("/security-contacts", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const contacts = await prisma.user.findMany({
      where: {
        societyId,
        role: UserRole.GUARD,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        phone: true,
      },
      orderBy: { name: "asc" },
    });

    return res.json({
      contacts: contacts
        .map((c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
        }))
        .filter((c) => (c.phone ?? "").toString().trim().length > 0),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/emergency-contacts - Get emergency contacts
router.get("/emergency-contacts", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId } = req.auth!;

    const raw = await prisma.emergencyContact.findMany({
      where: { residentId: userId },
      orderBy: { createdAt: "desc" },
    });

    const contacts = raw.map((c) => ({
      id: c.id,
      name: c.name,
      relationship: c.relation,
      phone: c.phone,
      address: c.address,
      createdAt: c.createdAt,
    }));

    return res.json({ contacts, count: contacts.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/emergency-contacts - Add emergency contact
router.post("/emergency-contacts", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(emergencyContactSchema), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { name, relationship, phone, address } = req.body;

    const created = await prisma.emergencyContact.create({
      data: {
        residentId: userId,
        name,
        relation: relationship,
        relationship,
        phone,
        address,
      },
    });

    return res.status(201).json({
      message: "Emergency contact added successfully",
      contact: {
        id: created.id,
        name: created.name,
        relationship: created.relation,
        phone: created.phone,
        address: created.address,
        createdAt: created.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/residents/emergency-contacts/:id - Remove emergency contact
router.delete("/emergency-contacts/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { id } = req.params;

    // Verify ownership
    const existing = await prisma.emergencyContact.findFirst({
      where: { id, residentId: userId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Emergency contact not found" });
    }

    await prisma.emergencyContact.delete({ where: { id } });

    return res.json({ message: "Emergency contact removed successfully" });
  } catch (error) {
    next(error);
  }
});

// ========================================
// ACCOUNT SETTINGS APIs
// ========================================

// ========================================
// SOS APIs
// ========================================

const MY_OPEN_SOS_LIST = [
  SOSStatus.CREATED,
  SOSStatus.ACTIVE,
  SOSStatus.PENDING,
  SOSStatus.ACKNOWLEDGED,
  SOSStatus.IN_PROGRESS,
];

// GET /api/residents/sos/active — current open SOS (at most one expected)
router.get("/sos/active", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const raw = await prisma.sOSAlert.findFirst({
      where: {
        triggeredBy: userId,
        societyId,
        status: { in: MY_OPEN_SOS_LIST },
      },
      include: {
        villa: { select: { villaNumber: true, block: true } },
        assignedGuard: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const alert = raw
      ? {
          ...raw,
          type: raw.emergencyType,
          description: raw.message,
        }
      : null;

    return res.json({ alert });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/my-sos - Get my SOS alerts
router.get("/my-sos", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const raw = await prisma.sOSAlert.findMany({
      where: {
        triggeredBy: userId,
        societyId,
      },
      include: {
        villa: {
          select: { villaNumber: true, block: true },
        },
        assignedGuard: {
          select: { id: true, name: true, phone: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const alerts = raw.map((a) => ({
      ...a,
      type: a.emergencyType,
      description: a.message,
    }));

    return res.json({ alerts, count: alerts.length });
  } catch (error) {
    next(error);
  }
});

// ========================================
// NOTICES APIs
// ========================================

// GET /api/residents/my-notices - Get notices for residents
router.get("/my-notices", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId, userId } = req.auth!;

    const rows = await prisma.notice.findMany({
      where: {
        societyId,
        OR: [
          { recipients: { none: {} } },
          { recipients: { some: { userId } } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        _count: { select: { recipients: true } },
      },
    });

    const notices = rows.map((n) => {
      const { _count, ...rest } = n;
      return {
        ...rest,
        attachmentUrl: n.fileUrl,
        audienceScope: _count.recipients > 0 ? "SELECTED" : "SOCIETY",
      };
    });

    return res.json({ notices, count: notices.length });
  } catch (error) {
    next(error);
  }
});

// ========================================
// DOCUMENTS APIs
// ========================================

// GET /api/residents/my-documents - Get society documents
router.get("/my-documents", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const documents = await prisma.document.findMany({
      where: {
        societyId,
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ documents, count: documents.length });
  } catch (error) {
    next(error);
  }
});

// ========================================
// POLLS APIs
// ========================================

// GET /api/residents/my-polls — polls for community tab + villa vote state
router.get("/my-polls", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId, villaId } = req.auth!;

    const polls = await prisma.poll.findMany({
      where: {
        societyId,
      },
      include: {
        options: {
          include: {
            _count: {
              select: { votes: true },
            },
          },
        },
        _count: {
          select: { votes: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const votesByPollId = new Map<string, string>();
    if (villaId && polls.length > 0) {
      const rows = await prisma.pollVote.findMany({
        where: {
          villaId,
          pollId: { in: polls.map((p) => p.id) },
        },
        select: { pollId: true, optionId: true },
      });
      for (const row of rows) {
        votesByPollId.set(row.pollId, row.optionId);
      }
    }

    const enriched = polls.map((p) => {
      const myVoteOptionId = villaId ? votesByPollId.get(p.id) ?? null : null;
      return {
        ...p,
        myVoteOptionId,
        hasVoted: myVoteOptionId != null,
      };
    });

    return res.json({ polls: enriched, count: enriched.length });
  } catch (error) {
    next(error);
  }
});

// ========================================
// ACCOUNT SETTINGS APIs
// ========================================

// PATCH /api/residents/change-password — requires current password + new password.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: passwordSchema,
});

router.patch("/change-password", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(changePasswordSchema), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashedPassword },
    });

    // Revoke all refresh tokens to force re-login on other devices.
    await prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });

    return res.json({ message: "Password changed successfully" });
  } catch (error) {
    next(error);
  }
});

// ========================================
// COMMUNITY DIRECTORY
// ========================================

// GET /api/residents/community-directory — searchable resident directory
router.get("/community-directory", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const pagination = getPagination(req);
    const q = ((req.query.q as string) || "").trim().toLowerCase();

    const where = {
      societyId,
      role: { in: [UserRole.RESIDENT, UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN] },
      isActive: true,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { villa: { villaNumber: { contains: q, mode: "insensitive" as const } } },
              { villa: { block: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };

    const select = {
      id: true,
      name: true,
      phone: true,
      villa: {
        select: {
          villaNumber: true,
          block: true,
        },
      },
    } as const;

    const [residents, total] = await Promise.all([
      prisma.user.findMany({
        where,
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { name: "asc" },
        select,
      }),
      prisma.user.count({ where }),
    ]);

    const rows = residents.map((r) => ({
      userId: r.id,
      name: r.name,
      villaNumber: r.villa?.villaNumber ?? null,
      block: r.villa?.block ?? null,
      phoneMasked: r.phone || null,
    }));

    return res.json({ residents: rows, count: rows.length, ...paginationMeta(total, rows.length, pagination) });
  } catch (error) {
    next(error);
  }
});

export default router;
