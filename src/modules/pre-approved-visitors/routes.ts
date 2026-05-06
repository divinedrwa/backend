import { UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifyGuardsPreApprovedCreated } from "../guards/visitorResidentApproval.service";

const router = Router();

const createPreApprovedVisitorSchema = z.object({
  villaId: z.string().cuid(),
  name: z.string().min(2).max(100),
  phone: z.string().min(10).max(15),
  purpose: z.string().optional(),
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime()
});

const verifyOtpSchema = z.object({
  otp: z.string().length(6)
});

// Generate 6-digit OTP
function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

router.use(requireAuth);

// List pre-approved visitors (admin sees all, resident sees own)
router.get("/", async (req, res, next) => {
  try {
    const whereClause: any = {
      societyId: req.auth!.societyId,
      validUntil: { gte: new Date() },
      isUsed: false
    };

    // Residents see only their villa's pre-approved visitors
    if (req.auth!.role === UserRole.RESIDENT && req.auth!.villaId) {
      whereClause.villaId = req.auth!.villaId;
    }

    const visitors = await prisma.preApprovedVisitor.findMany({
      where: whereClause,
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true
          }
        }
      },
      orderBy: { validFrom: "asc" }
    });

    return res.json({ visitors });
  } catch (error) {
    next(error);
  }
});

// Create pre-approved visitor with OTP (residents)
router.post(
  "/",
  validateBody(createPreApprovedVisitorSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createPreApprovedVisitorSchema>;

      // Verify villa access
      const villa = await prisma.villa.findFirst({
        where: {
          id: body.villaId,
          societyId: req.auth!.societyId
        }
      });

      if (!villa) {
        return res.status(404).json({ message: "Villa not found" });
      }

      // Residents can only pre-approve for their villa
      if (req.auth!.role === UserRole.RESIDENT) {
        if (req.auth!.villaId !== body.villaId) {
          return res.status(403).json({ message: "Cannot pre-approve for another villa" });
        }
      }

      const otp = generateOTP();

      const visitor = await prisma.preApprovedVisitor.create({
        data: {
          societyId: req.auth!.societyId,
          villaId: body.villaId,
          name: body.name,
          phone: body.phone,
          purpose: body.purpose,
          validFrom: new Date(body.validFrom),
          validUntil: new Date(body.validUntil),
          otp
        },
        include: {
          villa: {
            select: {
              villaNumber: true,
              block: true
            }
          }
        }
      });

      try {
        await notifyGuardsPreApprovedCreated({
          prisma,
          societyId: req.auth!.societyId,
          preApprovedId: visitor.id,
          visitorName: visitor.name,
          visitorPhone: visitor.phone,
          villa: visitor.villa,
        });
      } catch (notifyErr) {
        // eslint-disable-next-line no-console
        console.error("[pre-approved-visitors POST] guard notify error:", notifyErr);
      }

      return res.status(201).json({ visitor, otp });
    } catch (error) {
      next(error);
    }
  }
);

// Verify OTP at gate (guards)
router.post(
  "/verify",
  requireRole(UserRole.GUARD, UserRole.ADMIN),
  validateBody(verifyOtpSchema),
  async (req, res, next) => {
    try {
      const { otp } = req.body as z.infer<typeof verifyOtpSchema>;

      const visitor = await prisma.preApprovedVisitor.findFirst({
        where: {
          otp,
          societyId: req.auth!.societyId,
          isUsed: false,
          validFrom: { lte: new Date() },
          validUntil: { gte: new Date() }
        },
        include: {
          villa: {
            select: {
              villaNumber: true,
              block: true,
              ownerName: true
            }
          }
        }
      });

      if (!visitor) {
        return res.status(404).json({ message: "Invalid or expired OTP" });
      }

      // Mark as used
      await prisma.preApprovedVisitor.update({
        where: { id: visitor.id },
        data: {
          isUsed: true,
          usedAt: new Date()
        }
      });

      // Create visitor log entry
      await prisma.visitor.create({
        data: {
          societyId: req.auth!.societyId,
          createdBy: req.auth!.userId,
          name: visitor.name,
          phone: visitor.phone,
          purpose: visitor.purpose || "Pre-approved visit",
          villaVisits: {
            create: {
              villaId: visitor.villaId,
              notifiedAt: new Date()
            }
          }
        }
      });

      return res.json({ message: "Visitor verified and checked in", visitor });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
