import { Router } from "express";
import { z } from "zod";
import { Prisma, UserRole } from "@prisma/client";
import { residentLikeRoleFilter } from "../../lib/residentLike";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { logger } from "../../lib/logger";
import { notifySociety, notifyUsers } from "../../services/notification.service";
import { expenseAttachmentMemory } from "../../lib/expenseAttachmentUpload";
import {
  isCloudinaryConfigured,
  uploadExpenseAttachmentBuffer,
} from "../../services/cloudinaryExpenseAttachment";
import {
  createSpecialProjectWithContributions,
  type CreateSpecialProjectInput,
} from "../../lib/specialProjectDues";

const router = Router();
router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

// ─── Zod schemas ────────────────────────────────────────────

const contributionItemSchema = z.object({
  villaId: z.string().min(1),
  amount: z.number().positive(),
  dueDate: z.string().datetime().optional(),
});

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  type: z.enum(["REPAIR", "UPGRADE", "PURCHASE", "EVENT", "OTHER"]).default("OTHER"),
  targetAmount: z.number().positive(),
  contributions: z.array(contributionItemSchema).min(1),
});

const updateProjectSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  type: z.enum(["REPAIR", "UPGRADE", "PURCHASE", "EVENT", "OTHER"]).optional(),
  targetAmount: z.number().positive().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["COMPLETED", "CANCELLED"]),
});

const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "ONLINE"]).default("CASH"),
  reference: z.string().trim().max(255).optional(),
  paidAt: z.string().datetime().optional(),
  idempotencyKey: z.string().min(10).max(255).optional(),
});

const adHocChargeSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  type: z.enum(["REPAIR", "UPGRADE", "PURCHASE", "EVENT", "OTHER"]).default("OTHER"),
  dueDate: z.string().datetime().optional(),
  /** Single-villa shortcut (event fee / penalty). */
  villaId: z.string().min(1).optional(),
  amount: z.number().positive().optional(),
  /** Multi-villa ad-hoc charge (same as create project contributions). */
  charges: z.array(contributionItemSchema).min(1).max(500).optional(),
}).superRefine((body, ctx) => {
  const hasShortcut = body.villaId && body.amount != null;
  const hasCharges = (body.charges?.length ?? 0) > 0;
  if (hasShortcut === hasCharges) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either villaId+amount or charges[], not both",
    });
  }
});

async function assertVillasInSociety(
  societyId: string,
  contributions: Array<{ villaId: string; amount: number; dueDate?: string }>,
): Promise<void> {
  const villaIds = contributions.map((c) => c.villaId);
  const villas = await prisma.villa.findMany({
    where: { id: { in: villaIds }, societyId },
    select: { id: true },
  });
  const validIds = new Set(villas.map((v) => v.id));
  const invalid = villaIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    const err = new Error("Invalid villa IDs") as Error & { invalidVillaIds?: string[] };
    err.invalidVillaIds = invalid;
    throw err;
  }
}

async function createProjectForSociety(
  societyId: string,
  userId: string,
  input: Omit<CreateSpecialProjectInput, "societyId" | "createdById">,
) {
  await assertVillasInSociety(
    societyId,
    input.contributions.map((c) => ({
      villaId: c.villaId,
      amount: c.amount,
      dueDate: c.dueDate?.toISOString(),
    })),
  );

  return prisma.$transaction(async (tx) =>
    createSpecialProjectWithContributions(tx, {
      societyId,
      createdById: userId,
      ...input,
    }),
  );
}

const addExpenseSchema = z.object({
  description: z.string().trim().min(1).max(500),
  amount: z.number().positive(),
  vendor: z.string().trim().max(200).optional(),
  receiptUrl: z.string().url().optional(),
  expenseDate: z.string().datetime().optional(),
});

const updateExpenseSchema = z.object({
  description: z.string().trim().min(1).max(500).optional(),
  amount: z.number().positive().optional(),
  vendor: z.string().trim().max(200).optional(),
  receiptUrl: z.string().url().nullable().optional(),
  expenseDate: z.string().datetime().optional(),
});

// ─── Helpers ────────────────────────────────────────────────

function contributionStatus(paid: Prisma.Decimal, total: Prisma.Decimal) {
  const p = paid.toNumber();
  const t = total.toNumber();
  if (p >= t) return "PAID" as const;
  if (p > 0) return "PARTIALLY_PAID" as const;
  return "UNPAID" as const;
}

// ─── POST / — Create project ────────────────────────────────

router.post(
  "/",
  validateBody(createProjectSchema),
  async (req, res, next) => {
    try {
      const societyId = req.auth!.societyId;
      const userId = req.auth!.userId;
      const { title, description, type, targetAmount, contributions } = req.body as z.infer<typeof createProjectSchema>;

      const project = await createProjectForSociety(societyId, userId, {
        title,
        description,
        type,
        targetAmount,
        contributions: contributions.map((c) => ({
          villaId: c.villaId,
          amount: c.amount,
          dueDate: c.dueDate ? new Date(c.dueDate) : null,
        })),
      });

      // Fire-and-forget notification
      notifySociety(
        societyId,
        {
          title: "New Special Project",
          body: `"${title}" has been created. Check your contributions.`,
          data: { type: "SPECIAL_PROJECT_CREATED", projectId: project.id },
        },
        undefined,
        { category: "PROJECT" },
      ).catch((err) => logger.error(err, "Failed to send project creation notification"));

      res.status(201).json({ project });
    } catch (error) {
      if (error instanceof Error && "invalidVillaIds" in error) {
        return res.status(400).json({
          message: error.message,
          invalidVillaIds: (error as Error & { invalidVillaIds: string[] }).invalidVillaIds,
        });
      }
      next(error);
    }
  },
);

// ─── POST /ad-hoc-charge

router.post(
  "/ad-hoc-charge",
  validateBody(adHocChargeSchema),
  async (req, res, next) => {
    try {
      const societyId = req.auth!.societyId;
      const userId = req.auth!.userId;
      const body = req.body as z.infer<typeof adHocChargeSchema>;

      const contributions =
        body.charges?.map((c) => ({
          villaId: c.villaId,
          amount: c.amount,
          dueDate: c.dueDate ? new Date(c.dueDate) : body.dueDate ? new Date(body.dueDate) : null,
        })) ?? [
          {
            villaId: body.villaId!,
            amount: body.amount!,
            dueDate: body.dueDate ? new Date(body.dueDate) : null,
          },
        ];

      const targetAmount = contributions.reduce((sum, c) => sum + c.amount, 0);

      const project = await createProjectForSociety(societyId, userId, {
        title: body.title,
        description: body.description,
        type: body.type,
        targetAmount,
        contributions,
      });

      const villaIds = [...new Set(contributions.map((c) => c.villaId))];
      const residents = await prisma.user.findMany({
        where: { villaId: { in: villaIds }, ...residentLikeRoleFilter, isActive: true },
        select: { id: true },
      });
      if (residents.length > 0) {
        notifyUsers(
          residents.map((r) => r.id),
          {
            title: "New charge",
            body: `"${body.title}" — please review and pay your share.`,
            data: { type: "SPECIAL_PROJECT_CREATED", projectId: project.id },
          },
          { category: "PROJECT" },
        ).catch((err) => logger.error(err, "Failed to send ad-hoc charge notification"));
      }

      res.status(201).json({ project, adHoc: true });
    } catch (error) {
      if (error instanceof Error && "invalidVillaIds" in error) {
        return res.status(400).json({
          message: error.message,
          invalidVillaIds: (error as Error & { invalidVillaIds: string[] }).invalidVillaIds,
        });
      }
      next(error);
    }
  },
);

// ─── GET / — List projects (paginated) ─────────────────────

router.get("/", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const pagination = getPagination(req);
    const { status, search } = req.query;

    const where: Prisma.SpecialProjectWhereInput = { societyId };
    if (typeof status === "string" && status) {
      where.status = status as Prisma.EnumSpecialProjectStatusFilter;
    }
    if (typeof search === "string" && search.trim()) {
      where.OR = [
        { title: { contains: search.trim(), mode: "insensitive" } },
        { description: { contains: search.trim(), mode: "insensitive" } },
      ];
    }

    const [projects, total] = await Promise.all([
      prisma.specialProject.findMany({
        where,
        include: {
          createdBy: { select: { id: true, name: true } },
          _count: { select: { contributions: true, expenses: true } },
        },
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.specialProject.count({ where }),
    ]);

    res.json({ projects, ...paginationMeta(total, projects.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// ─── GET /:id — Project detail ──────────────────────────────

router.get("/:id", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;

    const project = await prisma.specialProject.findFirst({
      where: { id, societyId },
      include: {
        createdBy: { select: { id: true, name: true } },
        contributions: {
          include: {
            villa: { select: { id: true, villaNumber: true, ownerName: true } },
            _count: { select: { payments: true } },
          },
          orderBy: { villa: { villaNumber: "asc" } },
        },
        expenses: {
          include: { createdBy: { select: { id: true, name: true } } },
          orderBy: { expenseDate: "desc" },
          take: 10,
        },
        _count: { select: { contributions: true, expenses: true } },
      },
    });

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // Financial summary
    const summary = {
      targetAmount: project.targetAmount,
      totalCollected: project.totalCollected,
      totalExpenses: project.totalExpenses,
      balance: new Prisma.Decimal(project.totalCollected.toNumber() - project.totalExpenses.toNumber()),
      contributionCount: project._count.contributions,
      paidCount: project.contributions.filter((c) => c.status === "PAID").length,
      partialCount: project.contributions.filter((c) => c.status === "PARTIALLY_PAID").length,
      unpaidCount: project.contributions.filter((c) => c.status === "UNPAID").length,
    };

    res.json({ project, summary });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /:id — Update project metadata ───────────────────

router.patch(
  "/:id",
  validateBody(updateProjectSchema),
  async (req, res, next) => {
    try {
      const societyId = req.auth!.societyId;
      const { id } = req.params;
      const data = req.body as z.infer<typeof updateProjectSchema>;

      const existing = await prisma.specialProject.findFirst({ where: { id, societyId } });
      if (!existing) return res.status(404).json({ message: "Project not found" });
      if (existing.status !== "ACTIVE") {
        return res.status(400).json({ message: "Can only update active projects" });
      }

      const project = await prisma.specialProject.update({
        where: { id },
        data,
      });
      res.json({ project });
    } catch (error) {
      next(error);
    }
  },
);

// ─── PATCH /:id/status — Change status ─────────────────────

router.patch(
  "/:id/status",
  validateBody(updateStatusSchema),
  async (req, res, next) => {
    try {
      const societyId = req.auth!.societyId;
      const { id } = req.params;
      const { status } = req.body as z.infer<typeof updateStatusSchema>;

      const existing = await prisma.specialProject.findFirst({ where: { id, societyId } });
      if (!existing) return res.status(404).json({ message: "Project not found" });
      if (existing.status !== "ACTIVE") {
        return res.status(400).json({ message: "Can only change status of active projects" });
      }

      const project = await prisma.specialProject.update({
        where: { id },
        data: { status },
      });
      res.json({ project });
    } catch (error) {
      next(error);
    }
  },
);

// ─── GET /:id/contributions — Paginated contributions ──────

router.get("/:id/contributions", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;
    const pagination = getPagination(req);
    const { status } = req.query;

    const project = await prisma.specialProject.findFirst({ where: { id, societyId }, select: { id: true } });
    if (!project) return res.status(404).json({ message: "Project not found" });

    const where: Prisma.ProjectContributionWhereInput = { projectId: id };
    if (typeof status === "string" && status) {
      where.status = status as Prisma.EnumProjectContributionStatusFilter;
    }

    const [contributions, total] = await Promise.all([
      prisma.projectContribution.findMany({
        where,
        include: {
          villa: { select: { id: true, villaNumber: true, ownerName: true } },
          payments: {
            include: { markedBy: { select: { id: true, name: true } } },
            orderBy: { paidAt: "desc" },
          },
        },
        orderBy: { villa: { villaNumber: "asc" } },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.projectContribution.count({ where }),
    ]);

    res.json({ contributions, ...paginationMeta(total, contributions.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// ─── POST /:id/contributions/:contribId/payments — Record payment (idempotent) ─

router.post(
  "/:id/contributions/:contribId/payments",
  validateBody(recordPaymentSchema),
  async (req, res, next) => {
    try {
      const societyId = req.auth!.societyId;
      const userId = req.auth!.userId;
      const { id, contribId } = req.params;
      const { amount, method, reference, paidAt, idempotencyKey } = req.body as z.infer<typeof recordPaymentSchema>;

      // Idempotency check
      if (idempotencyKey) {
        const existing = await prisma.projectPayment.findUnique({
          where: { idempotencyKey },
          include: {
            contribution: {
              include: { villa: { select: { villaNumber: true, ownerName: true } } },
            },
          },
        });
        if (existing) {
          return res.status(200).json({
            payment: existing,
            note: "Payment already recorded (idempotent)",
          });
        }
      }

      // Verify project + contribution belong to society
      const contribution = await prisma.projectContribution.findFirst({
        where: { id: contribId, projectId: id, project: { societyId } },
        include: {
          project: { select: { id: true, status: true, totalCollected: true } },
          villa: { select: { id: true, villaNumber: true, ownerName: true } },
        },
      });
      if (!contribution) return res.status(404).json({ message: "Contribution not found" });
      if (contribution.project.status !== "ACTIVE") {
        return res.status(400).json({ message: "Project is not active" });
      }

      const result = await prisma.$transaction(
        async (tx) => {
          const payment = await tx.projectPayment.create({
            data: {
              contributionId: contribId,
              amount,
              method,
              reference,
              paidAt: paidAt ? new Date(paidAt) : new Date(),
              markedById: userId,
              idempotencyKey,
            },
          });

          const newPaidAmount = new Prisma.Decimal(contribution.paidAmount.toNumber() + amount);
          const status = contributionStatus(newPaidAmount, contribution.amount);

          await tx.projectContribution.update({
            where: { id: contribId },
            data: { paidAmount: newPaidAmount, status },
          });

          const newTotalCollected = new Prisma.Decimal(
            contribution.project.totalCollected.toNumber() + amount,
          );
          await tx.specialProject.update({
            where: { id },
            data: { totalCollected: newTotalCollected },
          });

          return payment;
        },
        { maxWait: 5000, timeout: 10000, isolationLevel: "Serializable" },
      );

      // Notify residents of this villa
      const residents = await prisma.user.findMany({
        where: { villaId: contribution.villa.id, ...residentLikeRoleFilter, isActive: true },
        select: { id: true },
      });
      if (residents.length > 0) {
        notifyUsers(
          residents.map((r) => r.id),
          {
            title: "Payment Recorded",
            body: `A payment of ₹${amount} has been recorded for your special project contribution.`,
            data: { type: "SPECIAL_PROJECT_PAYMENT_RECORDED", projectId: id },
          },
          { category: "PROJECT" },
        ).catch((err) => logger.error(err, "Failed to send payment notification"));
      }

      res.status(201).json({ payment: result });
    } catch (error) {
      next(error);
    }
  },
);

// ─── DELETE /:id/contributions/:contribId/payments/:paymentId — Remove payment ─

router.delete(
  "/:id/contributions/:contribId/payments/:paymentId",
  async (req, res, next) => {
    try {
      const societyId = req.auth!.societyId;
      const { id, contribId, paymentId } = req.params;

      const payment = await prisma.projectPayment.findFirst({
        where: {
          id: paymentId,
          contributionId: contribId,
          contribution: { projectId: id, project: { societyId } },
        },
        include: {
          contribution: {
            include: { project: { select: { totalCollected: true } } },
          },
        },
      });
      if (!payment) return res.status(404).json({ message: "Payment not found" });

      await prisma.$transaction(async (tx) => {
        await tx.projectPayment.delete({ where: { id: paymentId } });

        const newPaidAmount = new Prisma.Decimal(
          payment.contribution.paidAmount.toNumber() - payment.amount.toNumber(),
        );
        const status = contributionStatus(newPaidAmount, payment.contribution.amount);
        await tx.projectContribution.update({
          where: { id: contribId },
          data: { paidAmount: newPaidAmount, status },
        });

        const newTotalCollected = new Prisma.Decimal(
          payment.contribution.project.totalCollected.toNumber() - payment.amount.toNumber(),
        );
        await tx.specialProject.update({
          where: { id },
          data: { totalCollected: newTotalCollected },
        });
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

// ─── POST /:id/expenses/upload-receipt — Upload receipt to Cloudinary ─

router.post(
  "/:id/expenses/upload-receipt",
  expenseAttachmentMemory.single("file"),
  async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ message: "No file provided" });
      if (!isCloudinaryConfigured()) {
        return res.status(503).json({ message: "File storage is not configured" });
      }

      const societyId = req.auth!.societyId;
      const suffix = `project_${Date.now()}_${file.originalname.replace(/\s+/g, "_")}`;
      const uploaded = await uploadExpenseAttachmentBuffer(
        file.buffer,
        societyId,
        suffix,
        file.mimetype,
      );

      res.json({ receiptUrl: uploaded.secureUrl, fileSize: uploaded.bytes });
    } catch (error) {
      next(error);
    }
  },
);

// ─── POST /:id/expenses — Add expense ──────────────────────

router.post(
  "/:id/expenses",
  validateBody(addExpenseSchema),
  async (req, res, next) => {
    try {
      const societyId = req.auth!.societyId;
      const userId = req.auth!.userId;
      const { id } = req.params;
      const data = req.body as z.infer<typeof addExpenseSchema>;

      const project = await prisma.specialProject.findFirst({ where: { id, societyId } });
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.status !== "ACTIVE") {
        return res.status(400).json({ message: "Project is not active" });
      }

      const expense = await prisma.$transaction(async (tx) => {
        const exp = await tx.projectExpense.create({
          data: {
            projectId: id,
            description: data.description,
            amount: data.amount,
            vendor: data.vendor,
            receiptUrl: data.receiptUrl,
            expenseDate: data.expenseDate ? new Date(data.expenseDate) : new Date(),
            createdById: userId,
          },
        });

        await tx.specialProject.update({
          where: { id },
          data: {
            totalExpenses: new Prisma.Decimal(project.totalExpenses.toNumber() + data.amount),
          },
        });

        return exp;
      });

      res.status(201).json({ expense });
    } catch (error) {
      next(error);
    }
  },
);

// ─── GET /:id/expenses — List expenses (paginated) ─────────

router.get("/:id/expenses", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;
    const pagination = getPagination(req);

    const project = await prisma.specialProject.findFirst({ where: { id, societyId }, select: { id: true } });
    if (!project) return res.status(404).json({ message: "Project not found" });

    const where: Prisma.ProjectExpenseWhereInput = { projectId: id };
    const [expenses, total] = await Promise.all([
      prisma.projectExpense.findMany({
        where,
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { expenseDate: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.projectExpense.count({ where }),
    ]);

    res.json({ expenses, ...paginationMeta(total, expenses.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /:id/expenses/:expId — Update expense ───────────

router.patch(
  "/:id/expenses/:expId",
  validateBody(updateExpenseSchema),
  async (req, res, next) => {
    try {
      const societyId = req.auth!.societyId;
      const { id, expId } = req.params;
      const data = req.body as z.infer<typeof updateExpenseSchema>;

      const existing = await prisma.projectExpense.findFirst({
        where: { id: expId, projectId: id, project: { societyId } },
        include: { project: { select: { totalExpenses: true, status: true } } },
      });
      if (!existing) return res.status(404).json({ message: "Expense not found" });
      if (existing.project.status !== "ACTIVE") {
        return res.status(400).json({ message: "Project is not active" });
      }

      const expense = await prisma.$transaction(async (tx) => {
        const updated = await tx.projectExpense.update({
          where: { id: expId },
          data: {
            description: data.description,
            amount: data.amount,
            vendor: data.vendor,
            receiptUrl: data.receiptUrl,
            expenseDate: data.expenseDate ? new Date(data.expenseDate) : undefined,
          },
        });

        // If amount changed, update project totalExpenses
        if (data.amount !== undefined && data.amount !== existing.amount.toNumber()) {
          const diff = data.amount - existing.amount.toNumber();
          await tx.specialProject.update({
            where: { id },
            data: {
              totalExpenses: new Prisma.Decimal(
                existing.project.totalExpenses.toNumber() + diff,
              ),
            },
          });
        }

        return updated;
      });

      res.json({ expense });
    } catch (error) {
      next(error);
    }
  },
);

// ─── DELETE /:id/expenses/:expId — Delete expense ──────────

router.delete("/:id/expenses/:expId", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id, expId } = req.params;

    const existing = await prisma.projectExpense.findFirst({
      where: { id: expId, projectId: id, project: { societyId } },
      include: { project: { select: { totalExpenses: true } } },
    });
    if (!existing) return res.status(404).json({ message: "Expense not found" });

    await prisma.$transaction(async (tx) => {
      await tx.projectExpense.delete({ where: { id: expId } });
      await tx.specialProject.update({
        where: { id },
        data: {
          totalExpenses: new Prisma.Decimal(
            existing.project.totalExpenses.toNumber() - existing.amount.toNumber(),
          ),
        },
      });
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ─── GET /:id/summary — Financial summary ──────────────────

router.get("/:id/summary", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;

    const project = await prisma.specialProject.findFirst({
      where: { id, societyId },
      include: {
        contributions: { select: { status: true, amount: true, paidAmount: true } },
      },
    });
    if (!project) return res.status(404).json({ message: "Project not found" });

    const collected = project.totalCollected.toNumber();
    const spent = project.totalExpenses.toNumber();

    res.json({
      summary: {
        targetAmount: project.targetAmount,
        totalCollected: project.totalCollected,
        totalExpenses: project.totalExpenses,
        balance: collected - spent,
        collectionProgress: project.targetAmount.toNumber() > 0
          ? Math.round((collected / project.targetAmount.toNumber()) * 100)
          : 0,
        contributionStats: {
          total: project.contributions.length,
          paid: project.contributions.filter((c) => c.status === "PAID").length,
          partiallyPaid: project.contributions.filter((c) => c.status === "PARTIALLY_PAID").length,
          unpaid: project.contributions.filter((c) => c.status === "UNPAID").length,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /:id — Delete project (only if no payments) ─────

router.delete("/:id", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;

    const project = await prisma.specialProject.findFirst({
      where: { id, societyId },
      include: {
        contributions: {
          select: { _count: { select: { payments: true } } },
        },
      },
    });
    if (!project) return res.status(404).json({ message: "Project not found" });

    const hasPayments = project.contributions.some((c) => c._count.payments > 0);
    if (hasPayments) {
      return res.status(400).json({
        message: "Cannot delete a project that has recorded payments. Cancel it instead.",
      });
    }

    await prisma.specialProject.delete({ where: { id } });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

export default router;
