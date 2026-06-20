import { UserRole } from "@prisma/client";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { runVisitorApproveEntry } from "../guards/visitorApproveEntryFlow";
import {
  createPreApprovedVisitor,
  deactivatePreApprovedVisitor,
  listPreApprovedVisitors,
} from "../../services/preApprovedVisitor.service";

const router = Router();

const createPreApprovedVisitorSchema = z.object({
  villaId: z.string().cuid(),
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(10).max(15),
  purpose: z.string().trim().optional(),
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime()
});

const verifyOtpSchema = z.object({
  otp: z.string().length(6)
});

router.use(requireAuth);

const otpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many OTP attempts. Please wait and try again." },
});

// List pre-approved visitors (admin sees all, resident sees own villa)
router.get("/", async (req, res, next) => {
  try {
    const { societyId, role, villaId: authVillaId } = req.auth!;
    const pagination = getPagination(req);

    const villaId =
      role === UserRole.RESIDENT && authVillaId ? authVillaId : undefined;

    const { rows, summary } = await listPreApprovedVisitors(prisma, {
      societyId,
      villaId,
      gateEligibleOnly: true,
      take: pagination.take,
      skip: pagination.skip,
    });

    return res.json({
      visitors: rows,
      ...paginationMeta(summary.total, rows.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

// Create pre-approved visitor (same rules as POST /residents/pre-approve-visitor)
router.post(
  "/",
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  validateBody(createPreApprovedVisitorSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createPreApprovedVisitorSchema>;
      const { userId, societyId, role, villaId: authVillaId } = req.auth!;

      if (role === UserRole.RESIDENT) {
        if (!authVillaId || authVillaId !== body.villaId) {
          return res.status(403).json({ message: "Cannot pre-approve for another villa" });
        }
      }

      const visitor = await createPreApprovedVisitor(prisma, {
        societyId,
        villaId: body.villaId,
        approvedById: userId,
        name: body.name,
        phone: body.phone,
        purpose: body.purpose,
        validFrom: new Date(body.validFrom),
        validUntil: new Date(body.validUntil),
      });

      const otp = visitor.otp ?? "";
      return res.status(201).json({ visitor, otp });
    } catch (error) {
      const statusCode =
        error && typeof error === "object" && "statusCode" in error
          ? Number((error as { statusCode: number }).statusCode)
          : undefined;
      if (statusCode) {
        return res.status(statusCode).json({
          message: error instanceof Error ? error.message : "Request failed",
        });
      }
      next(error);
    }
  }
);

// DELETE /api/pre-approved-visitors/:id — soft-remove (web admin + residents)
router.delete(
  "/:id",
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  async (req, res, next) => {
    try {
      const { societyId, role, villaId: authVillaId } = req.auth!;
      const { id } = req.params;

      try {
        await deactivatePreApprovedVisitor(prisma, {
          id,
          societyId,
          role,
          actorVillaId: authVillaId,
        });
      } catch (error) {
        const statusCode =
          error && typeof error === "object" && "statusCode" in error
            ? Number((error as { statusCode: number }).statusCode)
            : undefined;
        if (statusCode) {
          return res.status(statusCode).json({
            message: error instanceof Error ? error.message : "Request failed",
          });
        }
        throw error;
      }

      return res.json({ message: "Pre-approved visitor removed" });
    } catch (error) {
      next(error);
    }
  },
);

// Verify OTP at gate — uses the same atomic admit flow as /guards/visitor-approve-entry
router.post(
  "/verify",
  otpRateLimiter,
  requireRole(UserRole.GUARD, UserRole.ADMIN),
  validateBody(verifyOtpSchema),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { otp } = req.body as z.infer<typeof verifyOtpSchema>;

      const match = await prisma.preApprovedVisitor.findFirst({
        where: {
          otp,
          societyId,
          isActive: true,
        },
        select: { villaId: true },
      });

      if (!match) {
        return res.status(404).json({ message: "Invalid or expired OTP" });
      }

      const result = await runVisitorApproveEntry(prisma, {
        userId,
        societyId,
        otp,
        villaId: match.villaId,
      });

      return res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
