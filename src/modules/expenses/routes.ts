import { Router } from 'express';
import { ExpenseStatus, ExpenseType, PaymentMode, Prisma, UserRole } from '@prisma/client';
import { z } from 'zod';
import { getPagination, paginationMeta } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { requireAuth, requireRole } from '../../middlewares/auth';
import { validateBody } from '../../middlewares/validate';

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

// ==========================================
// VALIDATION SCHEMAS
// ==========================================

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: z.nativeEnum(ExpenseType).optional(),
  icon: z.string().max(64).optional(),
  color: z.string().max(32).optional(),
  isRecurring: z.boolean().optional(),
  defaultAmount: z.number().nonnegative().optional(),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  icon: z.string().max(64).optional().nullable(),
  color: z.string().max(32).optional().nullable(),
  isActive: z.boolean().optional(),
  isRecurring: z.boolean().optional(),
  defaultAmount: z.number().nonnegative().optional().nullable(),
});

const expenseAttachmentSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileUrl: z.string().url().max(2048),
  fileType: z.string().max(64),
  fileSize: z.number().int().nonnegative(),
});

const createExpenseSchema = z.object({
  categoryId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  amount: z.number().nonnegative(),
  paymentDate: z.string().datetime().or(z.string().min(1)),
  paymentMode: z.nativeEnum(PaymentMode),
  paymentRef: z.string().max(200).optional(),
  paidTo: z.string().min(1).max(200),
  paidToContact: z.string().max(64).optional(),
  receiptUrl: z.string().url().max(2048).optional(),
  receiptNumber: z.string().max(100).optional(),
  invoiceNumber: z.string().max(100).optional(),
  month: z.number().int().min(1).max(12).optional(),
  year: z.number().int().min(2000).max(2100).optional(),
  gstAmount: z.number().nonnegative().optional(),
  gstPercentage: z.number().nonnegative().optional(),
  tdsAmount: z.number().nonnegative().optional(),
  tdsPercentage: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
  attachments: z.array(expenseAttachmentSchema).max(20).optional(),
});

const updateExpenseSchema = createExpenseSchema
  .omit({ attachments: true })
  .partial();

// ==========================================
// EXPENSE CATEGORIES
// ==========================================

// Get all categories
router.get('/categories', async (req, res) => {
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
    res.status(500).json({ error: 'Failed to fetch categories' });
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
      return res.status(404).json({ error: 'Category not found' });
    }

    const category = await prisma.expenseCategory.findUnique({ where: { id } });
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
      return res.status(404).json({ error: 'Category not found' });
    }

    const count = await prisma.expense.count({ where: { categoryId: id } });
    if (count > 0) {
      return res.status(400).json({
        error: 'Cannot delete category with existing expenses',
      });
    }

    await prisma.expenseCategory.delete({ where: { id } });

    res.json({ message: 'Category deleted' });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// EXPENSES
// ==========================================

// Get all expenses (with filters)
router.get('/', async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { 
      categoryId, 
      month, 
      year, 
      status,
      paymentMode,
      startDate,
      endDate,
      search
    } = req.query;
    const categoryIdParam = typeof categoryId === "string" ? categoryId : undefined;
    const statusParam = typeof status === "string" ? status : undefined;
    const paymentModeParam = typeof paymentMode === "string" ? paymentMode : undefined;
    
    const where: Prisma.ExpenseWhereInput = { societyId };
    
    if (categoryIdParam) where.categoryId = categoryIdParam;
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
      where: { id, societyId },
      include: {
        category: true,
        attachments: true,
      },
    });

    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
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
      return res.status(404).json({ error: 'Category not found' });
    }

    const gstAmount = body.gstAmount ?? 0;
    const tdsAmount = body.tdsAmount ?? 0;
    const netAmount = body.amount + gstAmount - tdsAmount;

    const expense = await prisma.expense.create({
      data: {
        societyId,
        categoryId: body.categoryId,
        title: body.title,
        description: body.description,
        amount: body.amount,
        paymentDate: new Date(body.paymentDate),
        paymentMode: body.paymentMode,
        paymentRef: body.paymentRef,
        paidTo: body.paidTo,
        paidToContact: body.paidToContact,
        receiptUrl: body.receiptUrl,
        receiptNumber: body.receiptNumber,
        invoiceNumber: body.invoiceNumber,
        month: body.month,
        year: body.year,
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
      },
    });

    if (body.month && body.year) {
      await updateMonthlySummary(societyId, body.month, body.year);
    }

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
      where: { id, societyId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    // If categoryId is being changed, the new category must also belong to
    // this society — otherwise an admin could re-parent into another tenant.
    if (body.categoryId && body.categoryId !== existing.categoryId) {
      const category = await prisma.expenseCategory.findFirst({
        where: { id: body.categoryId, societyId },
        select: { id: true },
      });
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }
    }

    const amount = body.amount ?? existing.amount;
    const gstAmount = body.gstAmount ?? existing.gstAmount ?? 0;
    const tdsAmount = body.tdsAmount ?? existing.tdsAmount ?? 0;
    const netAmount = amount + gstAmount - tdsAmount;

    const expense = await prisma.expense.update({
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
        ...(body.month !== undefined ? { month: body.month } : {}),
        ...(body.year !== undefined ? { year: body.year } : {}),
        notes: body.notes,
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
      },
      include: {
        category: true,
        attachments: true,
      },
    });

    if (expense.month && expense.year) {
      await updateMonthlySummary(expense.societyId, expense.month, expense.year);
    }

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

    // Capture month/year before delete for summary recalculation, scoped to society.
    const existing = await prisma.expense.findFirst({
      where: { id, societyId },
      select: { id: true, month: true, year: true },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    await prisma.expense.delete({ where: { id: existing.id } });

    if (existing.month && existing.year) {
      await updateMonthlySummary(societyId, existing.month, existing.year);
    }

    res.json({ message: 'Expense deleted' });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// MONTHLY SUMMARY
// ==========================================

// Get monthly summary
router.get('/summary/monthly', async (req, res) => {
  try {
    const societyId = req.auth!.societyId;
    const { month, year } = req.query;
    
    if (!month || !year) {
      return res.status(400).json({ error: 'Month and year required' });
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
    console.error('[expenses] GET /summary/monthly', error);
    res.status(500).json({
      message: 'Failed to fetch summary',
      error: 'Failed to fetch summary'
    });
  }
});

// Get yearly summary
router.get('/summary/yearly', async (req, res) => {
  try {
    const societyId = req.auth!.societyId;
    const { year } = req.query;
    
    if (!year) {
      return res.status(400).json({ error: 'Year required' });
    }
    
    const summaries = await prisma.monthlyExpenseSummary.findMany({
      where: {
        societyId,
        year: parseInt(year as string)
      },
      orderBy: { month: 'asc' }
    });
    
    // Calculate yearly total
    const yearlyTotal = summaries.reduce((sum, s) => sum + s.totalExpenses, 0);
    const yearlyGST = summaries.reduce((sum, s) => sum + s.totalGST, 0);
    const yearlyTDS = summaries.reduce((sum, s) => sum + s.totalTDS, 0);
    const yearlyNet = summaries.reduce((sum, s) => sum + s.netAmount, 0);
    const yearlyCount = summaries.reduce((sum, s) => sum + s.expenseCount, 0);
    
    res.json({
      year: parseInt(year as string),
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
    console.error('[expenses] GET /summary/yearly', error);
    res.status(500).json({
      message: 'Failed to fetch yearly summary',
      error: 'Failed to fetch yearly summary'
    });
  }
});

// Get category-wise breakdown
router.get('/summary/category-breakdown', async (req, res) => {
  try {
    const societyId = req.auth!.societyId;
    const { month, year } = req.query;

    const where: Prisma.ExpenseWhereInput = { societyId };
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
    console.error('[expenses] GET /summary/category-breakdown', error);
    res.status(500).json({
      message: 'Failed to fetch breakdown',
      error: 'Failed to fetch breakdown'
    });
  }
});

// ==========================================
// ANALYTICS
// ==========================================

// Get expense trends (last 12 months)
router.get('/analytics/trends', async (req, res) => {
  try {
    const societyId = req.auth!.societyId;
    
    const currentDate = new Date();
    const last12Months = [];
    
    for (let i = 11; i >= 0; i--) {
      const date = new Date(currentDate);
      date.setMonth(date.getMonth() - i);
      last12Months.push({
        month: date.getMonth() + 1,
        year: date.getFullYear()
      });
    }
    
    const trends = await Promise.all(
      last12Months.map(async ({ month, year }) => {
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
    console.error('[expenses] GET /analytics/trends', error);
    res.status(500).json({
      message: 'Failed to fetch trends',
      error: 'Failed to fetch trends'
    });
  }
});

// Get top categories
router.get('/analytics/top-categories', async (req, res) => {
  try {
    const societyId = req.auth!.societyId;
    const { year, limit = 10 } = req.query;
    
    const where: Prisma.ExpenseWhereInput = { societyId };
    if (year) where.year = parseInt(year as string);
    
    const expenses = await prisma.expense.groupBy({
      by: ['categoryId'],
      where,
      _sum: { amount: true },
      _count: { id: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: parseInt(limit as string)
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
    console.error('[expenses] GET /analytics/top-categories', error);
    res.status(500).json({
      message: 'Failed to fetch top categories',
      error: 'Failed to fetch top categories'
    });
  }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

async function updateMonthlySummary(societyId: string, month: number, year: number) {
  if (!month || !year) return;
  
  await calculateAndSaveMonthlySummary(societyId, month, year);
}

async function calculateAndSaveMonthlySummary(societyId: string, month: number, year: number) {
  const filterWhere = { societyId, month, year, status: 'APPROVED' as const };

  // Server-side aggregation: totals via aggregate(), breakdown via groupBy()
  const [aggregates, categoryGrouped] = await Promise.all([
    prisma.expense.aggregate({
      where: filterWhere,
      _sum: { amount: true, gstAmount: true, tdsAmount: true, netAmount: true },
      _count: { id: true },
    }),
    prisma.expense.groupBy({
      by: ['categoryId'],
      where: filterWhere,
      _sum: { amount: true },
    }),
  ]);

  const totalExpenses = aggregates._sum.amount ?? 0;
  const totalGST = aggregates._sum.gstAmount ?? 0;
  const totalTDS = aggregates._sum.tdsAmount ?? 0;
  const netAmount = aggregates._sum.netAmount ?? 0;
  const expenseCount = aggregates._count.id;

  // Build category breakdown keyed by category name
  let categoryBreakdown: Record<string, number> = {};
  if (categoryGrouped.length > 0) {
    const categoryIds = categoryGrouped.map(g => g.categoryId);
    const categories = await prisma.expenseCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(categories.map(c => [c.id, c.name]));
    categoryBreakdown = Object.fromEntries(
      categoryGrouped.map(g => [nameMap.get(g.categoryId) ?? 'Unknown', g._sum.amount ?? 0])
    );
  }

  return await prisma.monthlyExpenseSummary.upsert({
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
