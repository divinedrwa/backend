import { Router } from "express";
import { z } from "zod";
import { SocietyStatus, UserRole, VisitorMultiVillaApprovalMode } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

router.use(requireAuth);

const patchSocietySchema = z
  .object({
    visitorMultiVillaApprovalMode: z.nativeEnum(VisitorMultiVillaApprovalMode).optional(),
    visitorApprovalRequired: z.boolean().optional(),
    guardCanApproveVisitors: z.boolean().optional(),
    status: z.nativeEnum(SocietyStatus).optional(),
    upiVpa: z.string().min(3).regex(/@/, "Must contain @").nullable().optional(),
  })
  .refine(
    (body) =>
      body.visitorMultiVillaApprovalMode != null ||
      body.visitorApprovalRequired != null ||
      body.guardCanApproveVisitors != null ||
      body.status != null ||
      body.upiVpa !== undefined,
    { message: "Send at least one field to update" },
  );

/**
 * GET /api/society-settings — gate rules + lifecycle (ADMIN).
 */
router.get("/", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const society = await prisma.society.findUnique({
      where: { id: societyId },
      select: {
        id: true,
        name: true,
        status: true,
        visitorMultiVillaApprovalMode: true,
        visitorApprovalRequired: true,
        guardCanApproveVisitors: true,
        upiVpa: true,
      },
    });
    if (!society) {
      return res.status(404).json({ message: "Society not found" });
    }
    return res.json({ society });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/society-settings — update visitor rules and/or ACTIVE/INACTIVE.
 */
router.patch(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(patchSocietySchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const body = req.body as z.infer<typeof patchSocietySchema>;

      const data: {
        visitorMultiVillaApprovalMode?: VisitorMultiVillaApprovalMode;
        visitorApprovalRequired?: boolean;
        guardCanApproveVisitors?: boolean;
        status?: SocietyStatus;
        upiVpa?: string | null;
      } = {};

      if (body.visitorMultiVillaApprovalMode != null) {
        data.visitorMultiVillaApprovalMode = body.visitorMultiVillaApprovalMode;
      }
      if (body.visitorApprovalRequired != null) {
        data.visitorApprovalRequired = body.visitorApprovalRequired;
      }
      if (body.guardCanApproveVisitors != null) {
        data.guardCanApproveVisitors = body.guardCanApproveVisitors;
      }
      if (body.status != null) {
        data.status = body.status;
      }
      if (body.upiVpa !== undefined) {
        data.upiVpa = body.upiVpa;
      }

      const updated = await prisma.society.updateMany({
        where: { id: societyId },
        data,
      });

      if (updated.count === 0) {
        return res.status(404).json({ message: "Society not found" });
      }

      const society = await prisma.society.findUnique({
        where: { id: societyId },
        select: {
          id: true,
          name: true,
          status: true,
          visitorMultiVillaApprovalMode: true,
          visitorApprovalRequired: true,
          guardCanApproveVisitors: true,
          upiVpa: true,
        },
      });

      return res.json({
        message: "Society settings updated",
        society,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
