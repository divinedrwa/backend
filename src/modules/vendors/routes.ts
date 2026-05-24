import { UserRole, VendorCategory } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { auditFromRequest } from "../../services/audit.service";

const router = Router();

function emptyToUndefined(v: unknown): unknown {
  if (v === "" || v === null || v === undefined) return undefined;
  return v;
}

const phoneSchema = z
  .string()
  .trim()
  .min(8, "Phone must be at least 8 characters")
  .max(24, "Phone must be at most 24 characters");

const optionalEmail = z.preprocess(emptyToUndefined, z.string().email().optional());

const optionalDescription = z.preprocess(
  emptyToUndefined,
  z.string().max(10000).optional(),
);

const createVendorSchema = z.object({
  name: z.string().trim().min(2).max(100),
  category: z.nativeEnum(VendorCategory),
  phone: phoneSchema,
  email: optionalEmail,
  description: optionalDescription,
  isApproved: z.boolean().optional().default(false),
});

const updateVendorSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  category: z.nativeEnum(VendorCategory).optional(),
  phone: phoneSchema.optional(),
  email: optionalEmail,
  description: optionalDescription,
  isApproved: z.boolean().optional(),
});

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where = { societyId: req.auth!.societyId };
    const [vendors, total] = await Promise.all([
      prisma.vendor.findMany({
        where,
        orderBy: { name: "asc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.vendor.count({ where }),
    ]);
    return res.json({ vendors, ...paginationMeta(total, vendors.length, pagination) });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createVendorSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createVendorSchema>;

      const vendor = await prisma.vendor.create({
        data: {
          societyId: req.auth!.societyId,
          name: body.name,
          category: body.category,
          phone: body.phone,
          email: body.email ?? null,
          description: body.description ?? null,
          isApproved: body.isApproved,
        },
      });
      return res.status(201).json({ vendor });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateVendorSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updateVendorSchema>;
      const { id } = req.params;

      const existing = await prisma.vendor.findFirst({
        where: { id, societyId: req.auth!.societyId },
      });
      if (!existing) {
        return res.status(404).json({ message: "Vendor not found" });
      }

      const vendor = await prisma.vendor.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.category !== undefined && { category: body.category }),
          ...(body.phone !== undefined && { phone: body.phone }),
          ...(body.email !== undefined && { email: body.email ?? null }),
          ...(body.description !== undefined && { description: body.description ?? null }),
          ...(body.isApproved !== undefined && { isApproved: body.isApproved }),
        },
      });

      return res.json({ message: "Vendor updated", vendor });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  "/:id",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const vendor = await prisma.vendor.deleteMany({
        where: {
          id,
          societyId: req.auth!.societyId
        }
      });

      if (vendor.count === 0) {
        return res.status(404).json({ message: "Vendor not found" });
      }

      auditFromRequest(req, {
        societyId: req.auth!.societyId,
        adminId: req.auth!.userId,
        action: "VENDOR_DELETE",
        entityType: "Vendor",
        entityId: id,
      });

      return res.json({ message: "Vendor deleted" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
