import { Router } from 'express';
import { ExpenseStatus, ExpenseType, PaymentMode, Prisma, UserRole } from '@prisma/client';
import { z } from 'zod';
import { getPagination, paginationMeta } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { requireAuth, requireRole } from '../../middlewares/auth';
import { validateBody } from '../../middlewares/validate';
import { auditFromRequest } from '../../services/audit.service';
import { invalidateMoneySnapshotCache } from '../../lib/societyFinance';
import { expenseAttachmentMemory } from '../../lib/expenseAttachmentUpload';
import {
  isCloudinaryConfigured,
  uploadExpenseAttachmentBuffer,
} from '../../services/cloudinaryExpenseAttachment';

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

// ==========================================
// VALIDATION SCHEMAS
// ==========================================

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  type: z.nativeEnum(ExpenseType).optional(),
  icon: z.string().max(64).optional(),
  color: z.string().max(32).optional(),
  isRecurring: z.boolean().optional(),
  defaultAmount: z.number().nonnegative().optional(),
});

const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  icon: z.string().max(64).optional().nullable(),
  color: z.string().max(32).optional().nullable(),
  isActive: z.boolean().optional(),
  isRecurring: z.boolean().optional(),
  defaultAmount: z.number().nonnegative().optional().nullable(),
});

const expenseAttachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileUrl: z.string().url().max(2048),
  fileType: z.string().max(64),
  fileSize: z.number().int().nonnegative(),
});

const createExpenseSchema = z.object({
  categoryId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  amount: z.number().nonnegative(),
  paymentDate: z.string().datetime().or(z.string().min(1)),
  paymentMode: z.nativeEnum(PaymentMode),
  paymentRef: z.string().trim().max(200).optional(),
  paidTo: z.string().trim().min(1).max(200),
  paidToContact: z.string().trim().max(64).optional(),
  receiptUrl: z.string().url().max(2048).optional(),
  receiptNumber: z.string().trim().max(100).optional(),
  invoiceNumber: z.string().trim().max(100).optional(),
  month: z.number().int().min(1).max(12).optional(),
  year: z.number().int().min(2000).max(2100).optional(),
  financialYearId: z.string().optional(),
  gstAmount: z.number().nonnegative().optional(),
  gstPercentage: z.number().nonnegative().optional(),
  tdsAmount: z.number().nonnegative().optional(),
  tdsPercentage: z.number().nonnegative().optional(),
  notes: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().max(64)).max(50).optional(),
  attachments: z.array(expenseAttachmentSchema).max(20).optional(),
});

const updateExpenseSchema = createExpenseSchema
  .omit({ attachments: true })
  .partial();

// ==========================================
// EXPENSE CATEGORIES
// ==========================================

// Get all categories
router.get('/categories', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;

    const categories = await prisma.expenseCategory.findMany({
      where: { societyId },
      include: {
        _count: {
          select: { expenses: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    res.json(categories);
  } catch (error) {
    next(error);
  }
});

// Create category
router.post('/categories', validateBody(createCategorySchema), async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const body = req.body as z.infer<typeof createCategorySchema>;

    const category = await prisma.expenseCategory.create({
      data: {
        societyId,
        name: body.name,
        description: body.description,
        type: body.type,
        icon: body.icon,
        color: body.color,
        isRecurring: body.isRecurring,
        defaultAmount: body.defaultAmount,
        createdBy: req.auth!.userId,
      },
    });

    auditFromRequest(req, {
      adminId: req.auth!.userId,
      societyId,
      action: "EXPENSE_CATEGORY_CREATED",
      entityType: "ExpenseCategory",
      entityId: category.id,
    });

    res.json(category);
  } catch (error) {
    next(error);
  }
});

// Update category
router.put('/categories/:id', validateBody(updateCategorySchema), async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;
    const body = req.body as z.infer<typeof updateCategorySchema>;

    const result = await prisma.expenseCategory.updateMany({
      where: { id, societyId },
      data: body,
    });

    if (result.count === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }

    const category = await prisma.expenseCategory.findFirst({ where: { id, societyId } });

    auditFromRequest(req, {
      adminId: req.auth!.userId,
      societyId,
      action: "EXPENSE_CATEGORY_UPDATED",
      entityType: "ExpenseCategory",
      entityId: id,
    });

    res.json(category);
  } catch (error) {
    next(error);
  }
});

// Delete category
router.delete('/categories/:id', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;

    // Confirm category belongs to caller's society before any further work.
    const category = await prisma.expenseCategory.findFirst({
      where: { id, societyId },
      select: { id: true },
    });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    const count = await prisma.expense.count({ where: { categoryId: id, deletedAt: null } });
    if (count > 0) {
      return res.status(400).json({
        message: 'Cannot delete category with existing expenses',
      });
    }

    await prisma.expenseCategory.delete({ where: { id } });

    auditFromRequest(req, {
      adminId: req.auth!.userId,
      societyId,
      action: "EXPENSE_CATEGORY_DELETED",
      entityType: "ExpenseCategory",
      entityId: id,
    });

    res.json({ message: 'Category deleted' });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// EXPENSE ATTACHMENTS
// ==========================================

const addAttachmentsSchema = z.object({
  attachments: z.array(expenseAttachmentSchema).min(1).max(20),
});

// Upload 1-5 files to Cloudinary, return metadata array.
// Registered BEFORE /:id to avoid path collision.
router.post(
  '/upload-attachment',
  expenseAttachmentMemory.array('files', 5),
  async (req, res, next) => {
    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({ message: 'No files provided' });
      }
      if (!isCloudinaryConfigured()) {
        return res.status(503).json({ message: 'File storage is not configured' });
      }

      const societyId = req.auth!.societyId;
      const results: { fileName: string; fileUrl: string; fileType: string; fileSize: number }[] = [];

      for (const file of files) {
        const suffix = `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`;
        try {
          const uploaded = await uploadExpenseAttachmentBuffer(
            file.buffer,
            societyId,
            suffix,
            file.mimetype
          );
          results.push({
            fileName: file.originalname,
            fileUrl: uploaded.secureUrl,
            fileType: file.mimetype,
            fileSize: uploaded.bytes,
          });
        } catch {
          return res.status(502).json({ message: 'File upload failed' });
        }
      }

      res.json({ attachments: results });
    } catch (error) {
      next(error);
    }
  }
);

// Add pre-uploaded attachment metadata to an existing expense.
router.post(
  '/:id/attachments',
  validateBody(addAttachmentsSchema),
  async (req, res, next) => {
    try {
      const societyId = req.auth!.societyId;
      const { id } = req.params;
      const body = req.body as z.infer<typeof addAttachmentsSchema>;

      const expense = await prisma.expense.findFirst({
        where: { id, societyId, deletedAt: null },
        include: { attachments: { select: { id: true } } },
      });
      if (!expense) {
        return res.status(404).json({ message: 'Expense not found' });
      }

      const totalAfter = expense.attachments.length + body.attachments.length;
      if (totalAfter > 20) {
        return res.status(400).json({
          message: `Too many attachments. Current: ${expense.attachments.length}, adding: ${body.attachments.length}, max: 20.`,
        });
      }

      await prisma.expenseAttachment.createMany({
        data: body.attachments.map((a) => ({
          expenseId: id,
          fileName: a.fileName,
          fileUrl: a.fileUrl,
          fileType: a.fileType,
          fileSize: a.fileSize,
          uploadedBy: req.auth!.userId,
        })),
      });

      const updated = await prisma.expense.findUnique({
        where: { id },
        include: {
          category: true,
          attachments: true,
          financialYear: { select: { id: true, label: true } },
        },
      });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  }
);

// Delete a single attachment from an expense.
router.delete('/:id/attachments/:attachmentId', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id, attachmentId } = req.params;

    const expense = await prisma.expense.findFirst({
      where: { id, societyId, deletedAt: null },
      select: { id: true },
    });
    if (!expense) {
      return res.status(404).json({ message: 'Expense not found' });
    }

    const attachment = await prisma.expenseAttachment.findFirst({
      where: { id: attachmentId, expenseId: id },
      select: { id: true },
    });
    if (!attachment) {
      return res.status(404).json({ message: 'Attachment not found' });
    }

    await prisma.expenseAttachment.delete({ where: { id: attachmentId } });

    res.json({ message: 'Attachment deleted' });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// EXPENSES
// ==========================================

// Aggregate stats for the current filter set (server-side)
router.get('/stats', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { categoryId, month, year, financialYearId, status, paymentMode, search } = req.query;

    const where: Prisma.ExpenseWhereInput = { societyId, deletedAt: null };
    if (typeof categoryId === "string" && categoryId) where.categoryId = categoryId;
    if (typeof financialYearId === "string" && financialYearId) where.financialYearId = financialYearId;
    if (month) where.month = parseInt(month as string);
    if (year) where.year = parseInt(year as string);
    if (typeof status === "string" && status) where.status = status as ExpenseStatus;
    if (typeof paymentMode === "string" && paymentMode) where.paymentMode = paymentMode as PaymentMode;
    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } },
        { paidTo: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const [agg, count, thisMonthAgg, thisYearAgg] = await Promise.all([
      prisma.expense.aggregate({ where, _sum: { amount: true } }),
      prisma.expense.count({ where }),
      prisma.expense.aggregate({
        where: { ...where, month: currentMonth, year: currentYear },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { ...where, year: currentYear },
        _sum: { amount: true },
      }),
    ]);

    res.json({
      total: Number(agg._sum.amount ?? 0),
      count,
      thisMonth: Number(thisMonthAgg._sum.amount ?? 0),
      thisYear: Number(thisYearAgg._sum.amount ?? 0),
    });
  } catch (error) {
    next(error);
  }
});

// Get all expenses (with filters)
router.get('/', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const {
      categoryId,
      month,
      year,
      financialYearId,
      status,
      paymentMode,
      startDate,
      endDate,
      search
    } = req.query;
    const categoryIdParam = typeof categoryId === "string" ? categoryId : undefined;
    const financialYearIdParam = typeof financialYearId === "string" ? financialYearId : undefined;
    const statusParam = typeof status === "string" ? status : undefined;
    const paymentModeParam = typeof paymentMode === "string" ? paymentMode : undefined;

    const where: Prisma.ExpenseWhereInput = { societyId, deletedAt: null };

    if (categoryIdParam) where.categoryId = categoryIdParam;
    if (financialYearIdParam) where.financialYearId = financialYearIdParam;
    if (month) where.month = parseInt(month as string);
    if (year) where.year = parseInt(year as string);
    if (statusParam) where.status = statusParam as ExpenseStatus;
    if (paymentModeParam) where.paymentMode = paymentModeParam as PaymentMode;
    
    if (startDate || endDate) {
      const paymentDate: Prisma.DateTimeFilter = {};
      if (startDate) paymentDate.gte = new Date(startDate as string);
      if (endDate) paymentDate.lte = new Date(endDate as string);
      where.paymentDate = paymentDate;
    }
    
    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } },
        { paidTo: { contains: search as string, mode: 'insensitive' } }
      ];
    }
    
    const pagination = getPagination(req);
    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        include: {
          category: true,
          attachments: true,
          financialYear: { select: { id: true, label: true } },
        },
        orderBy: { paymentDate: 'desc' },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.expense.count({ where }),
    ]);

    // Pre-existing clients call this endpoint and expect a bare array.
    // Surface pagination metadata via response headers so we can ship the
    // server-side cap without breaking them.
    res.setHeader('X-Total-Count', String(total));
    res.setHeader(
      'X-Pagination',
      JSON.stringify(paginationMeta(total, expenses.length, pagination)),
    );
    res.json(expenses);
  } catch (error) {
    next(error);
  }
});

// Get single expense
router.get('/:id', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;

    const expense = await prisma.expense.findFirst({
      where: { id, societyId, deletedAt: null },
      include: {
        category: true,
        attachments: true,
        financialYear: { select: { id: true, label: true } },
      },
    });

    if (!expense) {
      return res.status(404).json({ message: 'Expense not found' });
    }

    res.json(expense);
  } catch (error) {
    next(error);
  }
});

// Create expense
router.post('/', validateBody(createExpenseSchema), async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const body = req.body as z.infer<typeof createExpenseSchema>;

    // Tenant integrity: the referenced category must belong to this society.
    const category = await prisma.expenseCategory.findFirst({
      where: { id: body.categoryId, societyId },
      select: { id: true },
    });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    const payDate = new Date(body.paymentDate);
    const expMonth = body.month ?? (payDate.getMonth() + 1);
    const expYear = body.year ?? payDate.getFullYear();

    // Resolve FY: use explicit selection, or find matching FY by date range.
    let financialYearId = body.financialYearId ?? null;
    if (!financialYearId) {
      const fy = await prisma.financialYear.findFirst({
        where: {
          societyId,
          startDate: { lte: payDate },
          endDate: { gte: payDate },
        },
        select: { id: true },
      });
      financialYearId = fy?.id ?? null;
    }

    const gstAmount = body.gstAmount ?? 0;
    const tdsAmount = body.tdsAmount ?? 0;
    const netAmount = body.amount + gstAmount - tdsAmount;

    const expense = await prisma.$transaction(async (tx) => {
      const created = await tx.expense.create({
        data: {
          societyId,
          categoryId: body.categoryId,
          title: body.title,
          description: body.description,
          amount: body.amount,
          paymentDate: payDate,
          paymentMode: body.paymentMode,
          paymentRef: body.paymentRef,
          paidTo: body.paidTo,
          paidToContact: body.paidToContact,
          receiptUrl: body.receiptUrl,
          receiptNumber: body.receiptNumber,
          invoiceNumber: body.invoiceNumber,
          month: expMonth,
          year: expYear,
          financialYearId,
          gstAmount,
          gstPercentage: body.gstPercentage ?? 0,
          tdsAmount,
          tdsPercentage: body.tdsPercentage ?? 0,
          netAmount,
          status: 'APPROVED', // Auto-approve for now
          notes: body.notes,
          tags: body.tags ?? [],
          createdBy: req.auth!.userId,
          attachments: body.attachments && body.attachments.length > 0
            ? {
                create: body.attachments.map((a) => ({
                  fileName: a.fileName,
                  fileUrl: a.fileUrl,
                  fileType: a.fileType,
                  fileSize: a.fileSize,
                  uploadedBy: req.auth!.userId,
                })),
              }
            : undefined,
        },
        include: {
          category: true,
          attachments: true,
          financialYear: { select: { id: true, label: true } },
        },
      });

      await updateMonthlySummary(societyId, expMonth, expYear, tx);

      return created;
    });

    invalidateMoneySnapshotCache(societyId);
    auditFromRequest(req, {
      adminId: req.auth!.userId,
      societyId,
      action: "EXPENSE_CREATED",
      entityType: "Expense",
      entityId: expense.id,
      metadata: { title: expense.title, amount: expense.amount },
    });

    res.json(expense);
  } catch (error) {
    next(error);
  }
});

// Update expense
router.put('/:id', validateBody(updateExpenseSchema), async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;
    const body = req.body as z.infer<typeof updateExpenseSchema>;

    // Tenant scope: the existing expense must belong to this society.
    const existing = await prisma.expense.findFirst({
      where: { id, societyId, deletedAt: null },
    });
    if (!existing) {
      return res.status(404).json({ message: 'Expense not found' });
    }

    // If categoryId is being changed, the new category must also belong to
    // this society — otherwise an admin could re-parent into another tenant.
    if (body.categoryId && body.categoryId !== existing.categoryId) {
      const category = await prisma.expenseCategory.findFirst({
        where: { id: body.categoryId, societyId },
        select: { id: true },
      });
      if (!category) {
        return res.status(404).json({ message: 'Category not found' });
      }
    }

    // Derive month/year from paymentDate when not explicitly provided
    const effectivePayDate = body.paymentDate ? new Date(body.paymentDate) : existing.paymentDate;
    const expMonth = body.month ?? (body.paymentDate ? (effectivePayDate.getMonth() + 1) : undefined);
    const expYear = body.year ?? (body.paymentDate ? effectivePayDate.getFullYear() : undefined);

    // Resolve FY: use explicit selection, or find matching FY by date range when paymentDate changes.
    let financialYearId: string | null | undefined = undefined;
    if (body.financialYearId !== undefined) {
      financialYearId = body.financialYearId || null;
    } else if (body.paymentDate) {
      const fy = await prisma.financialYear.findFirst({
        where: {
          societyId,
          startDate: { lte: effectivePayDate },
          endDate: { gte: effectivePayDate },
        },
        select: { id: true },
      });
      financialYearId = fy?.id ?? null;
    }

    const amount = Number(body.amount ?? existing.amount);
    const gstAmount = Number(body.gstAmount ?? existing.gstAmount ?? 0);
    const tdsAmount = Number(body.tdsAmount ?? existing.tdsAmount ?? 0);
    const netAmount = amount + gstAmount - tdsAmount;

    const expense = await prisma.$transaction(async (tx) => {
      const updated = await tx.expense.update({
        where: { id },
        data: {
          ...(body.categoryId ? { categoryId: body.categoryId } : {}),
          title: body.title,
          description: body.description,
          amount: body.amount,
          paymentDate: body.paymentDate ? new Date(body.paymentDate) : undefined,
          paymentMode: body.paymentMode,
          paymentRef: body.paymentRef,
          paidTo: body.paidTo,
          paidToContact: body.paidToContact,
          receiptUrl: body.receiptUrl,
          receiptNumber: body.receiptNumber,
          invoiceNumber: body.invoiceNumber,
          gstAmount,
          gstPercentage: body.gstPercentage ?? 0,
          tdsAmount,
          tdsPercentage: body.tdsPercentage ?? 0,
          netAmount,
          ...(expMonth !== undefined ? { month: expMonth } : {}),
          ...(expYear !== undefined ? { year: expYear } : {}),
          ...(financialYearId !== undefined ? { financialYearId } : {}),
          notes: body.notes,
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
        },
        include: {
          category: true,
          attachments: true,
          financialYear: { select: { id: true, label: true } },
        },
      });

      // Recalculate new month's summary
      if (updated.month && updated.year) {
        await updateMonthlySummary(updated.societyId, updated.month, updated.year, tx);
      }

      // If month/year changed, also recalculate the OLD month's summary so stale
      // totals don't linger (e.g. expense moved from Feb → Jan).
      const oldMonth = existing.month;
      const oldYear = existing.year;
      if (oldMonth && oldYear && (oldMonth !== updated.month || oldYear !== updated.year)) {
        await updateMonthlySummary(updated.societyId, oldMonth, oldYear, tx);
      }

      return updated;
    });

    invalidateMoneySnapshotCache(societyId);
    auditFromRequest(req, {
      adminId: req.auth!.userId,
      societyId,
      action: "EXPENSE_UPDATED",
      entityType: "Expense",
      entityId: id,
    });

    res.json(expense);
  } catch (error) {
    next(error);
  }
});

// Delete expense
router.delete('/:id', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;

    // Capture month/year before soft-delete for summary recalculation, scoped to society.
    const existing = await prisma.expense.findFirst({
      where: { id, societyId, deletedAt: null },
      select: { id: true, month: true, year: true },
    });
    if (!existing) {
      return res.status(404).json({ message: 'Expense not found' });
    }

    await prisma.expense.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });

    if (existing.month && existing.year) {
      await updateMonthlySummary(societyId, existing.month, existing.year);
    }

    invalidateMoneySnapshotCache(societyId);
    auditFromRequest(req, {
      adminId: req.auth!.userId,
      societyId,
      action: "EXPENSE_DELETED",
      entityType: "Expense",
      entityId: id,
    });

    res.json({ message: 'Expense deleted' });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// MONTHLY SUMMARY
// ==========================================

// Get monthly summary
router.get('/summary/monthly', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year required' });
    }

    let summary = await prisma.monthlyExpenseSummary.findUnique({
      where: {
        societyId_month_year: {
          societyId,
          month: parseInt(month as string),
          year: parseInt(year as string)
        }
      }
    });

    // If not exists, calculate and create
    if (!summary) {
      summary = await calculateAndSaveMonthlySummary(
        societyId,
        parseInt(month as string),
        parseInt(year as string)
      );
    }

    res.json(summary);
  } catch (error) {
    next(error);
  }
});

// Get yearly summary (supports financialYearId or calendar year)
router.get('/summary/yearly', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { year, financialYearId } = req.query;

    // Build list of (month, year) pairs to query
    let monthPairs: { month: number; year: number }[] = [];
    let fyLabel: string | null = null;

    if (financialYearId) {
      const fy = await prisma.financialYear.findFirst({
        where: { id: financialYearId as string, societyId },
      });
      if (!fy) return res.status(404).json({ message: 'Financial year not found' });
      fyLabel = fy.label;
      const cursor = new Date(fy.startDate.getFullYear(), fy.startDate.getMonth(), 1);
      const end = fy.endDate;
      while (cursor <= end) {
        monthPairs.push({ month: cursor.getMonth() + 1, year: cursor.getFullYear() });
        cursor.setMonth(cursor.getMonth() + 1);
      }
    } else if (year) {
      const y = parseInt(year as string);
      monthPairs = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, year: y }));
    } else {
      return res.status(400).json({ message: 'Year or financialYearId required' });
    }

    const summaries = await Promise.all(
      monthPairs.map(async ({ month, year: y }) => {
        const s = await prisma.monthlyExpenseSummary.findUnique({
          where: { societyId_month_year: { societyId, month, year: y } },
        });
        return s ?? { month, year: y, totalExpenses: 0, totalGST: 0, totalTDS: 0, netAmount: 0, expenseCount: 0 };
      })
    );

    const yearlyTotal = summaries.reduce((sum, s) => sum + Number(s.totalExpenses), 0);
    const yearlyGST = summaries.reduce((sum, s) => sum + Number(s.totalGST), 0);
    const yearlyTDS = summaries.reduce((sum, s) => sum + Number(s.totalTDS), 0);
    const yearlyNet = summaries.reduce((sum, s) => sum + Number(s.netAmount), 0);
    const yearlyCount = summaries.reduce((sum, s) => sum + s.expenseCount, 0);

    res.json({
      year: year ? parseInt(year as string) : null,
      financialYearLabel: fyLabel,
      monthlySummaries: summaries,
      yearlyTotal: {
        totalExpenses: yearlyTotal,
        totalGST: yearlyGST,
        totalTDS: yearlyTDS,
        netAmount: yearlyNet,
        expenseCount: yearlyCount
      }
    });
  } catch (error) {
    next(error);
  }
});

// Get category-wise breakdown
router.get('/summary/category-breakdown', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { month, year, financialYearId } = req.query;

    const where: Prisma.ExpenseWhereInput = { societyId, status: 'APPROVED', deletedAt: null };
    if (financialYearId) {
      where.financialYearId = financialYearId as string;
    }
    if (month) where.month = parseInt(month as string);
    if (year) where.year = parseInt(year as string);

    // Server-side aggregation using Prisma groupBy
    const grouped = await prisma.expense.groupBy({
      by: ['categoryId'],
      where,
      _sum: { amount: true },
      _count: { id: true },
    });

    // Fetch category details for the grouped results
    const categoryIds = grouped.map(g => g.categoryId);
    const categories = await prisma.expenseCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true, type: true, color: true },
    });

    const categoryMap = new Map(categories.map(c => [c.id, c]));

    const breakdown = grouped.map(g => {
      const cat = categoryMap.get(g.categoryId);
      return {
        categoryId: g.categoryId,
        categoryName: cat?.name ?? 'Unknown',
        categoryType: cat?.type ?? null,
        categoryColor: cat?.color ?? null,
        totalAmount: g._sum.amount ?? 0,
        count: g._count.id,
      };
    });

    res.json(breakdown);
  } catch (error) {
    next(error);
  }
});

// ==========================================
// ANALYTICS
// ==========================================

// Get expense trends (FY months or last 12 months fallback)
router.get('/analytics/trends', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { financialYearId } = req.query;

    const monthPairs: { month: number; year: number }[] = [];

    if (financialYearId) {
      const fy = await prisma.financialYear.findFirst({
        where: { id: financialYearId as string, societyId },
      });
      if (!fy) return res.status(404).json({ message: 'Financial year not found' });
      const cursor = new Date(fy.startDate.getFullYear(), fy.startDate.getMonth(), 1);
      const end = fy.endDate;
      while (cursor <= end) {
        monthPairs.push({ month: cursor.getMonth() + 1, year: cursor.getFullYear() });
        cursor.setMonth(cursor.getMonth() + 1);
      }
    } else {
      const currentDate = new Date();
      for (let i = 11; i >= 0; i--) {
        const date = new Date(currentDate);
        date.setMonth(date.getMonth() - i);
        monthPairs.push({
          month: date.getMonth() + 1,
          year: date.getFullYear()
        });
      }
    }

    const trends = await Promise.all(
      monthPairs.map(async ({ month, year }) => {
        const summary = await prisma.monthlyExpenseSummary.findUnique({
          where: {
            societyId_month_year: { societyId, month, year }
          }
        });

        return {
          month,
          year,
          totalExpenses: summary?.totalExpenses || 0,
          expenseCount: summary?.expenseCount || 0
        };
      })
    );

    res.json(trends);
  } catch (error) {
    next(error);
  }
});

// Get top categories
router.get('/analytics/top-categories', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { year, financialYearId, limit = 10 } = req.query;

    const where: Prisma.ExpenseWhereInput = { societyId, status: 'APPROVED', deletedAt: null };
    if (financialYearId) {
      where.financialYearId = financialYearId as string;
    } else if (year) {
      where.year = parseInt(year as string);
    }

    const expenses = await prisma.expense.groupBy({
      by: ['categoryId'],
      where,
      _sum: { amount: true },
      _count: { id: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: Math.min(Math.max(parseInt(limit as string) || 20, 1), 200)
    });

    // Get category details
    const categoryIds = expenses.map(e => e.categoryId);
    const categories = await prisma.expenseCategory.findMany({
      where: { id: { in: categoryIds } }
    });

    const result = expenses.map(expense => {
      const category = categories.find(c => c.id === expense.categoryId);
      return {
        categoryId: expense.categoryId,
        categoryName: category?.name,
        categoryColor: category?.color,
        totalAmount: expense._sum.amount,
        count: expense._count.id
      };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/** Transaction-compatible Prisma client subset used by helpers. */
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function updateMonthlySummary(societyId: string, month: number, year: number, db: TxClient | typeof prisma = prisma) {
  if (!month || !year) return;

  await calculateAndSaveMonthlySummary(societyId, month, year, db);
}

async function calculateAndSaveMonthlySummary(societyId: string, month: number, year: number, db: TxClient | typeof prisma = prisma) {
  const filterWhere = { societyId, month, year, status: 'APPROVED' as const, deletedAt: null as Date | null };

  // Server-side aggregation: totals via aggregate(), breakdown via groupBy()
  const [aggregates, categoryGrouped] = await Promise.all([
    db.expense.aggregate({
      where: filterWhere,
      _sum: { amount: true, gstAmount: true, tdsAmount: true, netAmount: true },
      _count: { id: true },
    }),
    db.expense.groupBy({
      by: ['categoryId'],
      where: filterWhere,
      _sum: { amount: true },
    }),
  ]);

  const totalExpenses = Number(aggregates._sum.amount ?? 0);
  const totalGST = Number(aggregates._sum.gstAmount ?? 0);
  const totalTDS = Number(aggregates._sum.tdsAmount ?? 0);
  const netAmount = Number(aggregates._sum.netAmount ?? 0);
  const expenseCount = aggregates._count.id;

  // Build category breakdown keyed by category name
  let categoryBreakdown: Record<string, number> = {};
  if (categoryGrouped.length > 0) {
    const categoryIds = categoryGrouped.map(g => g.categoryId);
    const categories = await db.expenseCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(categories.map(c => [c.id, c.name]));
    categoryBreakdown = Object.fromEntries(
      categoryGrouped.map(g => [nameMap.get(g.categoryId) ?? 'Unknown', Number(g._sum.amount ?? 0)])
    );
  }

  return await db.monthlyExpenseSummary.upsert({
    where: {
      societyId_month_year: { societyId, month, year }
    },
    update: {
      totalExpenses,
      totalGST,
      totalTDS,
      netAmount,
      expenseCount,
      categoryBreakdown,
      lastCalculated: new Date()
    },
    create: {
      societyId,
      month,
      year,
      totalExpenses,
      totalGST,
      totalTDS,
      netAmount,
      expenseCount,
      categoryBreakdown,
      lastCalculated: new Date()
    }
  });
}

export default router;
