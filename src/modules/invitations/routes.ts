import { randomBytes } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { InvitationStatus, SocietyStatus, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

/**
 * GET /api/invitations/verify/:token — no auth (onboarding prereq).
 * Does not expose the raw invite token beyond this URL segment.
 */
router.get("/verify/:token", async (req, res, next) => {
  try {
    const token = req.params.token?.trim();
    if (!token) {
      res.status(400).json({ message: "Missing token" });
      return;
    }

    const inv = await prisma.invitation.findUnique({
      where: { token },
      select: {
        status: true,
        expiresAt: true,
        role: true,
        phone: true,
        email: true,
        acceptedAt: true,
        villaId: true,
        villa: {
          select: {
            id: true,
            villaNumber: true,
            block: true,
          },
        },
        society: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    });

    if (!inv) {
      res.status(404).json({ message: "Invitation not found" });
      return;
    }

    const expired = inv.expiresAt <= new Date();
    const inactiveSociety = inv.society.status === SocietyStatus.INACTIVE;

    let effectiveStatus: InvitationStatus = inv.status;
    if (
      inv.status === InvitationStatus.PENDING &&
      expired &&
      !inv.acceptedAt
    ) {
      effectiveStatus = InvitationStatus.EXPIRED;
      await prisma.invitation.updateMany({
        where: { token },
        data: { status: InvitationStatus.EXPIRED },
      });
    }

    res.json({
      valid:
        effectiveStatus === InvitationStatus.PENDING &&
        !expired &&
        !inactiveSociety,
      invitation: {
        status: effectiveStatus,
        role: inv.role,
        phone: inv.phone,
        email: inv.email,
        society: {
          id: inv.society.id,
          name: inv.society.name,
          status: inv.society.status,
        },
        villa: inv.villa
          ? {
              id: inv.villa.id,
              villaNumber: inv.villa.villaNumber,
              block: inv.villa.block,
            }
          : null,
        villaId: inv.villaId,
        expiresAt: inv.expiresAt.toISOString(),
      },
    });
  } catch (e) {
    next(e);
  }
});

router.use(requireAuth);

function newInviteToken(): string {
  return randomBytes(24).toString("hex");
}

const createInvitationSchema = z
  .object({
    role: z.nativeEnum(UserRole),
    villaId: z.string().min(1).optional(),
    phone: z.string().min(5).nullable().optional(),
    email: z.string().email().nullable().optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === UserRole.SUPER_ADMIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cannot invite SUPER_ADMIN",
        path: ["role"],
      });
    }
    if (!(data.phone?.trim() || data.email?.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide phone or email",
        path: ["phone"],
      });
    }
    if (data.role !== UserRole.RESIDENT && data.villaId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "villaId is only allowed for RESIDENT invitations",
        path: ["villaId"],
      });
    }
  });

/**
 * POST /api/invitations — create a pending invitation (ADMIN, scoped to JWT society).
 */
router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createInvitationSchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      if (!societyId) {
        res.status(403).json({ message: "Society context required" });
        return;
      }

      const body = req.body as z.infer<typeof createInvitationSchema>;

      const society = await prisma.society.findUnique({
        where: { id: societyId },
        select: { status: true },
      });
      if (!society || society.status === SocietyStatus.INACTIVE) {
        res.status(403).json({ message: "Society not available" });
        return;
      }

      const phone = body.phone?.trim() || null;
      const email = body.email?.trim().toLowerCase() || null;
      const expiresAt =
        body.expiresAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      let villaId: string | null = null;
      if (body.role === UserRole.RESIDENT && body.villaId?.trim()) {
        const villa = await prisma.villa.findFirst({
          where: {
            id: body.villaId.trim(),
            societyId,
          },
          select: { id: true },
        });
        if (!villa) {
          res.status(400).json({ message: "Villa not found in this society" });
          return;
        }
        villaId = villa.id;
      }

      const invitation = await prisma.invitation.create({
        data: {
          societyId,
          role: body.role,
          villaId,
          phone,
          email,
          token: newInviteToken(),
          expiresAt,
          status: InvitationStatus.PENDING,
        },
        select: {
          id: true,
          role: true,
          phone: true,
          email: true,
          villaId: true,
          token: true,
          status: true,
          expiresAt: true,
          createdAt: true,
          villa: {
            select: {
              villaNumber: true,
              block: true,
            },
          },
        },
      });

      res.status(201).json({ invitation });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * GET /api/invitations — list invitations for society (ADMIN).
 */
router.get("/", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    if (!societyId) {
      res.status(403).json({ message: "Society context required" });
      return;
    }
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const where = {
      societyId,
      ...(status &&
      Object.values(InvitationStatus).includes(status as InvitationStatus)
        ? { status: status as InvitationStatus }
        : {}),
    };

    const invitations = await prisma.invitation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        role: true,
        phone: true,
        email: true,
        villaId: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        acceptedAt: true,
        villa: {
          select: {
            villaNumber: true,
            block: true,
          },
        },
      },
    });

    res.json({ invitations });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/invitations/:id/revoke — mark REVOKED (ADMIN).
 */
router.patch("/:id/revoke", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    if (!societyId) {
      res.status(403).json({ message: "Society context required" });
      return;
    }
    const id = req.params.id;

    const updated = await prisma.invitation.updateMany({
      where: {
        id,
        societyId,
        status: InvitationStatus.PENDING,
      },
      data: { status: InvitationStatus.REVOKED },
    });

    if (updated.count === 0) {
      res.status(404).json({ message: "Invitation not found or not revokable" });
      return;
    }

    res.json({ message: "Invitation revoked" });
  } catch (e) {
    next(e);
  }
});

export default router;
