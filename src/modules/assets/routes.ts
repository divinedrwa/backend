import { AssetCondition, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(2).max(200),
  category: z.string().trim().min(1).max(100),
  location: z.string().trim().max(200).optional(),
  serialNumber: z.string().trim().max(100).optional(),
  purchaseDate: z.string().pipe(z.coerce.date()).optional(),
  purchaseValue: z.number().min(0).optional(),
  currentValue: z.number().min(0).optional(),
  condition: z.nativeEnum(AssetCondition).optional().default("GOOD"),
  warrantyExpiry: z.string().pipe(z.coerce.date()).optional(),
  assignedTo: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  location: z.string().trim().max(200).optional().nullable(),
  serialNumber: z.string().trim().max(100).optional().nullable(),
  purchaseDate: z.string().pipe(z.coerce.date()).optional().nullable(),
  purchaseValue: z.number().min(0).optional().nullable(),
  currentValue: z.number().min(0).optional().nullable(),
  condition: z.nativeEnum(AssetCondition).optional(),
  warrantyExpiry: z.string().pipe(z.coerce.date()).optional().nullable(),
  assignedTo: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
});

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const category = req.query.category as string | undefined;
    const condition = req.query.condition as AssetCondition | undefined;

    const where = {
      societyId: req.auth!.societyId,
      ...(category && { category }),
      ...(condition && { condition }),
    };

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: { name: "asc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.asset.count({ where }),
    ]);

    return res.json({ assets, ...paginationMeta(total, assets.length, pagination) });
  } catch (error) {
    next(error);
  }
});

router.get("/categories", async (req, res, next) => {
  try {
    const categories = await prisma.asset.groupBy({
      by: ["category"],
      where: { societyId: req.auth!.societyId },
      _count: true,
      orderBy: { category: "asc" },
    });
    return res.json({ categories: categories.map((c) => ({ name: c.category, count: c._count })) });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const asset = await prisma.asset.findFirst({
      where: { id: req.params.id, societyId: req.auth!.societyId },
    });
    if (!asset) return res.status(404).json({ message: "Asset not found" });
    return res.json({ asset });
  } catch (error) {
    next(error);
  }
});

router.post("/", validateBody(createSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSchema>;
    const asset = await prisma.asset.create({
      data: {
        societyId: req.auth!.societyId,
        name: body.name,
        category: body.category,
        location: body.location ?? null,
        serialNumber: body.serialNumber ?? null,
        purchaseDate: body.purchaseDate ?? null,
        purchaseValue: body.purchaseValue ?? null,
        currentValue: body.currentValue ?? null,
        condition: body.condition,
        warrantyExpiry: body.warrantyExpiry ?? null,
        assignedTo: body.assignedTo ?? null,
        notes: body.notes ?? null,
      },
    });
    return res.status(201).json({ asset });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", validateBody(updateSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof updateSchema>;
    const existing = await prisma.asset.findFirst({
      where: { id: req.params.id, societyId: req.auth!.societyId },
    });
    if (!existing) return res.status(404).json({ message: "Asset not found" });

    const asset = await prisma.asset.update({
      where: { id: req.params.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.category !== undefined && { category: body.category }),
        ...(body.location !== undefined && { location: body.location }),
        ...(body.serialNumber !== undefined && { serialNumber: body.serialNumber }),
        ...(body.purchaseDate !== undefined && { purchaseDate: body.purchaseDate }),
        ...(body.purchaseValue !== undefined && { purchaseValue: body.purchaseValue }),
        ...(body.currentValue !== undefined && { currentValue: body.currentValue }),
        ...(body.condition !== undefined && { condition: body.condition }),
        ...(body.warrantyExpiry !== undefined && { warrantyExpiry: body.warrantyExpiry }),
        ...(body.assignedTo !== undefined && { assignedTo: body.assignedTo }),
        ...(body.notes !== undefined && { notes: body.notes }),
      },
    });
    return res.json({ message: "Asset updated", asset });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const result = await prisma.asset.deleteMany({
      where: { id: req.params.id, societyId: req.auth!.societyId },
    });
    if (result.count === 0) return res.status(404).json({ message: "Asset not found" });
    return res.json({ message: "Asset deleted" });
  } catch (error) {
    next(error);
  }
});

export default router;
