import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { profileImageMemory } from "../../lib/profileImageUpload";
import { computeSocietyMoneySnapshot } from "../../lib/societyFinance";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { isCloudinaryConfigured, uploadProfileImageBuffer } from "../../services/cloudinaryProfile";
import { MaintenanceBillingRole, UserRole, SOSStatus } from "@prisma/client";

const updateProfileSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  notifyEmail: z.boolean().optional(),
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
  name: z.string().min(2),
  relationship: z.string().min(2),
  age: z.number().int().positive().optional(),
  phone: z.string().optional(),
  idProof: z.string().optional(),
});

const emergencyContactSchema = z.object({
  name: z.string().min(2),
  relationship: z.string().min(2),
  phone: z.string().min(10),
  address: z.string().optional(),
});

// ========================================
// DASHBOARD API
// ========================================

// GET /api/residents/dashboard - Get resident dashboard
router.get("/dashboard", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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

    // Get pending maintenance count (billing contact only; others see 0)
    const pendingMaintenance =
      maintenanceBillingExcluded || !villaId
        ? 0
        : await prisma.maintenance.count({
            where: { villaId, status: "PENDING" },
          });

    // Total complaints filed by this resident (all statuses). Same rows as GET /my-complaints without ?status=
    const complaintCount = await prisma.complaint.count({
      where: {
        societyId,
        residentId: userId,
      },
    });

    // Get undelivered parcels count
    const pendingParcels = villaId
      ? await prisma.parcel.count({
          where: {
            villaId,
            status: { in: ["RECEIVED", "PENDING"] },
          },
        })
      : 0;

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    // Get upcoming bookings count
    const upcomingBookings = await prisma.amenityBooking.count({
      where: {
        residentId: userId,
        status: { in: ["CONFIRMED", "PENDING"] },
        startTime: { gte: now },
      },
    });

    // Canonical society money snapshot — same source of truth the admin
    // dashboard uses, so admin and resident views can never disagree on
    // the society's bank-account balance.
    const money = await computeSocietyMoneySnapshot(prisma, societyId);

    const mergedAllTimeInflow = money.additionalFundsAllTime;
    const mergedMonthInflow = money.additionalFundsForMonth(month, year);
    const allTimeCollected = money.maintenanceCashAllTime + mergedAllTimeInflow;
    const allTimeSpent = money.expensesAllTime;
    const currentBalance = money.currentFundBalance;
    const monthCashReceived = money.maintenanceCashForMonth(month, year);
    const monthCollected = monthCashReceived + mergedMonthInflow;
    const monthSpent = money.expensesForMonth(month, year);
    const monthNet = monthCollected - monthSpent;

    return res.json({
      user: {
        name: user?.name,
        email: user?.email,
        phone: user?.phone,
        villa: user?.villa,
      },
      stats: {
        pendingMaintenance,
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
      });
      if (!parsed.success) {
        return res.status(400).json({
          message: "Validation failed",
          issues: parsed.error.flatten(),
        });
      }
      ({ name, phone, email, notifyEmail } = parsed.data);
    } else {
      const b = req.body as z.infer<typeof updateProfileSchema>;
      name = b.name;
      phone = b.phone;
      email = b.email;
      notifyEmail = b.notifyEmail;
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
        // eslint-disable-next-line no-console
        console.error("[cloudinary] profile upload", e);
        return res.status(502).json({ message: "Could not upload image. Try again." });
      }
    }

    const hasText =
      (name !== undefined && name !== "") ||
      phone !== undefined ||
      (email !== undefined && email !== "") ||
      notifyEmail !== undefined;
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
router.get("/me", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
  requireRole(UserRole.RESIDENT),
  conditionalProfileImageUpload,
  conditionalValidateProfileJson,
  updateResidentProfile
);

// PUT /api/residents/me — same as PATCH (Flutter fallback)
router.put(
  "/me",
  requireRole(UserRole.RESIDENT),
  conditionalProfileImageUpload,
  conditionalValidateProfileJson,
  updateResidentProfile
);

// DELETE /api/residents/me — resident soft-deletes own account (isActive=false; row retained)
router.delete("/me", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const existing = await prisma.user.findFirst({
      where: { id: userId, societyId, role: UserRole.RESIDENT },
      select: { id: true, isActive: true },
    });

    if (!existing) {
      return res.status(404).json({ message: "Profile not found" });
    }

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
      message:
        "Your account has been deactivated. Data is retained for society records; contact admin to restore access.",
      deactivated: true,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/my-villa - Get my villa details
router.get("/my-villa", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/my-family", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const familyMembers = await prisma.familyMember.findMany({
      where: { residentId: userId },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ familyMembers, count: familyMembers.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/add-family-member - Add family member
router.post("/add-family-member", requireRole(UserRole.RESIDENT), validateBody(addFamilyMemberSchema), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { name, relationship, age, phone, idProof } = req.body;

    const familyMember = await prisma.familyMember.create({
      data: {
        residentId: userId,
        name,
        relation: relationship, // Schema field is 'relation'
        age,
        phone,
        idProof,
      },
    });

    return res.status(201).json({ message: "Family member added successfully", familyMember });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/residents/family/:id - Update family member
router.patch("/family/:id", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { id } = req.params;
    const { name, relationship, age, phone, idProof } = req.body;

    // Verify ownership
    const existing = await prisma.familyMember.findFirst({
      where: { id, residentId: userId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Family member not found" });
    }

    const familyMember = await prisma.familyMember.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(relationship && { relation: relationship }),
        ...(age && { age }),
        ...(phone && { phone }),
        ...(idProof && { idProof }),
      },
    });

    return res.json({ message: "Family member updated successfully", familyMember });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/residents/family/:id - Remove family member
router.delete("/family/:id", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/security-contacts", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/emergency-contacts", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId } = req.auth!;

    const contacts = await prisma.emergencyContact.findMany({
      where: { residentId: userId },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ contacts, count: contacts.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/emergency-contacts - Add emergency contact
router.post("/emergency-contacts", requireRole(UserRole.RESIDENT), validateBody(emergencyContactSchema), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { name, relationship, phone, address } = req.body;

    const contact = await prisma.emergencyContact.create({
      data: {
        residentId: userId,
        name,
        relation: relationship, // Schema field is 'relation'
        phone,
        address,
      },
    });

    return res.status(201).json({ message: "Emergency contact added successfully", contact });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/residents/emergency-contacts/:id - Remove emergency contact
router.delete("/emergency-contacts/:id", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/sos/active", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const alert = await prisma.sOSAlert.findFirst({
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

    return res.json({ alert });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/my-sos - Get my SOS alerts
router.get("/my-sos", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId, villaId } = req.auth!;

    const sosAlerts = await prisma.sOSAlert.findMany({
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

    return res.json({ alerts: sosAlerts, count: sosAlerts.length });
  } catch (error) {
    next(error);
  }
});

// ========================================
// NOTICES APIs
// ========================================

// GET /api/residents/my-notices - Get notices for residents
router.get("/my-notices", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/my-documents", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.get("/my-polls", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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
router.patch("/change-password", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: unknown;
    };

    if (typeof currentPassword !== "string" || currentPassword.trim().length === 0) {
      return res.status(400).json({ message: "Current password is required" });
    }

    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isValid = await bcrypt.compare(currentPassword.trim(), user.passwordHash);
    if (!isValid) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashedPassword },
    });

    return res.json({ message: "Password changed successfully" });
  } catch (error) {
    next(error);
  }
});

export default router;
