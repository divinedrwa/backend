import { ContractStatus, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createSchema = z.object({
  vendorId: z.string().min(1),
  title: z.string().trim().min(2).max(200),
  description: z.string().max(5000).optional(),
  status: z.nativeEnum(ContractStatus).optional().default("DRAFT"),
  startDate: z.string().pipe(z.coerce.date()),
  endDate: z.string().pipe(z.coerce.date()),
  amount: z.number().min(0),
  paymentTerms: z.string().max(500).optional(),
  autoRenew: z.boolean().optional().default(false),
  documentUrl: z.string().url().optional(),
  notes: z.string().max(5000).optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().max(5000).optional().nullable(),
  status: z.nativeEnum(ContractStatus).optional(),
  startDate: z.string().pipe(z.coerce.date()).optional(),
  endDate: z.string().pipe(z.coerce.date()).optional(),
  amount: z.number().min(0).optional(),
  paymentTerms: z.string().max(500).optional().nullable(),
  autoRenew: z.boolean().optional(),
  documentUrl: z.string().url().optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
});

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const status = req.query.status as ContractStatus | undefined;
    const vendorId = req.query.vendorId as string | undefined;

    const where = {
      societyId: req.auth!.societyId,
      ...(status && { status }),
      ...(vendorId && { vendorId }),
    };

    const [contracts, total] = await Promise.all([
      prisma.vendorContract.findMany({
        where,
        include: {
          vendor: { select: { id: true, name: true, category: true } },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { endDate: "asc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.vendorContract.count({ where }),
    ]);

    return res.json({ contracts, ...paginationMeta(total, contracts.length, pagination) });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const contract = await prisma.vendorContract.findFirst({
      where: { id: req.params.id, societyId: req.auth!.societyId },
      include: {
        vendor: { select: { id: true, name: true, category: true, phone: true, email: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!contract) return res.status(404).json({ message: "Contract not found" });
    return res.json({ contract });
  } catch (error) {
    next(error);
  }
});

router.post("/", validateBody(createSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSchema>;

    const vendor = await prisma.vendor.findFirst({
      where: { id: body.vendorId, societyId: req.auth!.societyId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const contract = await prisma.vendorContract.create({
      data: {
        societyId: req.auth!.societyId,
        vendorId: body.vendorId,
        title: body.title,
        description: body.description ?? null,
        status: body.status,
        startDate: body.startDate,
        endDate: body.endDate,
        amount: body.amount,
        paymentTerms: body.paymentTerms ?? null,
        autoRenew: body.autoRenew,
        documentUrl: body.documentUrl ?? null,
        notes: body.notes ?? null,
        createdById: req.auth!.userId,
      },
      include: {
        vendor: { select: { id: true, name: true, category: true } },
      },
    });

    return res.status(201).json({ contract });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", validateBody(updateSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof updateSchema>;
    const existing = await prisma.vendorContract.findFirst({
      where: { id: req.params.id, societyId: req.auth!.societyId },
    });
    if (!existing) return res.status(404).json({ message: "Contract not found" });

    const contract = await prisma.vendorContract.update({
      where: { id: req.params.id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.startDate !== undefined && { startDate: body.startDate }),
        ...(body.endDate !== undefined && { endDate: body.endDate }),
        ...(body.amount !== undefined && { amount: body.amount }),
        ...(body.paymentTerms !== undefined && { paymentTerms: body.paymentTerms }),
        ...(body.autoRenew !== undefined && { autoRenew: body.autoRenew }),
        ...(body.documentUrl !== undefined && { documentUrl: body.documentUrl }),
        ...(body.notes !== undefined && { notes: body.notes }),
      },
      include: {
        vendor: { select: { id: true, name: true, category: true } },
      },
    });

    return res.json({ message: "Contract updated", contract });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const result = await prisma.vendorContract.deleteMany({
      where: { id: req.params.id, societyId: req.auth!.societyId },
    });
    if (result.count === 0) return res.status(404).json({ message: "Contract not found" });
    return res.json({ message: "Contract deleted" });
  } catch (error) {
    next(error);
  }
});

export default router;
