import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireAuth, requireRole } from '../../middlewares/auth';

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

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
router.post('/categories', async (req, res) => {
  try {
    const societyId = req.auth!.societyId;
    const { name, description, type, icon, color, isRecurring, defaultAmount } = req.body;
    
    const category = await prisma.expenseCategory.create({
      data: {
        societyId,
        name,
        description,
        type,
        icon,
        color,
        isRecurring,
        defaultAmount,
        createdBy: req.auth!.userId
      }
    });
    
    res.json(category);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// Update category
router.put('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, icon, color, isActive, isRecurring, defaultAmount } = req.body;
    
    const category = await prisma.expenseCategory.update({
      where: { id },
      data: {
        name,
        description,
        icon,
        color,
        isActive,
        isRecurring,
        defaultAmount
      }
    });
    
    res.json(category);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// Delete category
router.delete('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if category has expenses
    const count = await prisma.expense.count({ where: { categoryId: id } });
    if (count > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete category with existing expenses' 
      });
    }
    
    await prisma.expenseCategory.delete({ where: { id } });
    
    res.json({ message: 'Category deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// ==========================================
// EXPENSES
// ==========================================

// Get all expenses (with filters)
router.get('/', async (req, res) => {
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
    
    const where: any = { societyId };
    
    if (categoryId) where.categoryId = categoryId;
    if (month) where.month = parseInt(month as string);
    if (year) where.year = parseInt(year as string);
    if (status) where.status = status;
    if (paymentMode) where.paymentMode = paymentMode;
    
    if (startDate || endDate) {
      where.paymentDate = {};
      if (startDate) where.paymentDate.gte = new Date(startDate as string);
      if (endDate) where.paymentDate.lte = new Date(endDate as string);
    }
    
    if (search) {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } },
        { paidTo: { contains: search as string, mode: 'insensitive' } }
      ];
    }
    
    const expenses = await prisma.expense.findMany({
      where,
      include: {
        category: true,
        attachments: true
      },
      orderBy: { paymentDate: 'desc' }
    });
    
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// Get single expense
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const expense = await prisma.expense.findUnique({
      where: { id },
      include: {
        category: true,
        attachments: true
      }
    });
    
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    
    res.json(expense);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch expense' });
  }
});

// Create expense
router.post('/', async (req, res) => {
  try {
    const societyId = req.auth!.societyId;
    const {
      categoryId,
      title,
      description,
      amount,
      paymentDate,
      paymentMode,
      paymentRef,
      paidTo,
      paidToContact,
      receiptUrl,
      receiptNumber,
      invoiceNumber,
      month,
      year,
      gstAmount,
      gstPercentage,
      tdsAmount,
      tdsPercentage,
      notes,
      tags,
      attachments
    } = req.body;
    
    // Calculate net amount
    const netAmount = amount + (gstAmount || 0) - (tdsAmount || 0);
    
    const expense = await prisma.expense.create({
      data: {
        societyId,
        categoryId,
        title,
        description,
        amount,
        paymentDate: new Date(paymentDate),
        paymentMode,
        paymentRef,
        paidTo,
        paidToContact,
        receiptUrl,
        receiptNumber,
        invoiceNumber,
        month,
        year,
        gstAmount: gstAmount || 0,
        gstPercentage: gstPercentage || 0,
        tdsAmount: tdsAmount || 0,
        tdsPercentage: tdsPercentage || 0,
        netAmount,
        status: 'APPROVED', // Auto-approve for now
        notes,
        tags: tags || [],
        createdBy: req.auth!.userId,
        attachments: {
          create: attachments || []
        }
      },
      include: {
        category: true,
        attachments: true
      }
    });
    
    // Update monthly summary
    await updateMonthlySummary(societyId, month, year);
    
    res.json(expense);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

// Update expense
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      categoryId,
      title,
      description,
      amount,
      paymentDate,
      paymentMode,
      paymentRef,
      paidTo,
      paidToContact,
      receiptUrl,
      receiptNumber,
      invoiceNumber,
      month: bodyMonth,
      year: bodyYear,
      gstAmount,
      gstPercentage,
      tdsAmount,
      tdsPercentage,
      notes,
      tags
    } = req.body;
    
    // Calculate net amount
    const netAmount = amount + (gstAmount || 0) - (tdsAmount || 0);
    
    const expense = await prisma.expense.update({
      where: { id },
      data: {
        ...(categoryId ? { categoryId } : {}),
        title,
        description,
        amount,
        paymentDate: paymentDate ? new Date(paymentDate) : undefined,
        paymentMode,
        paymentRef,
        paidTo,
        paidToContact,
        receiptUrl,
        receiptNumber,
        invoiceNumber,
        gstAmount: gstAmount || 0,
        gstPercentage: gstPercentage || 0,
        tdsAmount: tdsAmount || 0,
        tdsPercentage: tdsPercentage || 0,
        netAmount,
        ...(bodyMonth !== undefined && bodyMonth !== null && bodyMonth !== ""
          ? {
              month:
                typeof bodyMonth === "number"
                  ? bodyMonth
                  : parseInt(String(bodyMonth), 10),
            }
          : {}),
        ...(bodyYear !== undefined && bodyYear !== null && bodyYear !== ""
          ? {
              year:
                typeof bodyYear === "number"
                  ? bodyYear
                  : parseInt(String(bodyYear), 10),
            }
          : {}),
        notes,
        tags: tags || []
      },
      include: {
        category: true,
        attachments: true
      }
    });
    
    // Update monthly summary
    const summaryMonth = expense.month;
    const summaryYear = expense.year;
    if (summaryMonth && summaryYear) {
      await updateMonthlySummary(expense.societyId, summaryMonth, summaryYear);
    }
    
    res.json(expense);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

// Delete expense
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const expense = await prisma.expense.findUnique({ where: { id } });
    
    await prisma.expense.delete({ where: { id } });
    
    // Update monthly summary
    if (expense && expense.month && expense.year) {
      await updateMonthlySummary(expense.societyId, expense.month, expense.year);
    }
    
    res.json({ message: 'Expense deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete expense' });
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
    
    const where: any = { societyId };
    if (month) where.month = parseInt(month as string);
    if (year) where.year = parseInt(year as string);
    
    const expenses = await prisma.expense.findMany({
      where,
      include: { category: true }
    });
    
    // Group by category
    const breakdown: any = {};
    expenses.forEach(expense => {
      const catName = expense.category.name;
      if (!breakdown[catName]) {
        breakdown[catName] = {
          categoryId: expense.categoryId,
          categoryName: catName,
          categoryType: expense.category.type,
          categoryColor: expense.category.color,
          totalAmount: 0,
          count: 0
        };
      }
      breakdown[catName].totalAmount += expense.amount;
      breakdown[catName].count += 1;
    });
    
    res.json(Object.values(breakdown));
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
    
    const where: any = { societyId };
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
  const expenses = await prisma.expense.findMany({
    where: {
      societyId,
      month,
      year,
      status: 'APPROVED'
    },
    include: { category: true }
  });
  
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const totalGST = expenses.reduce((sum, e) => sum + (e.gstAmount || 0), 0);
  const totalTDS = expenses.reduce((sum, e) => sum + (e.tdsAmount || 0), 0);
  const netAmount = expenses.reduce((sum, e) => sum + e.netAmount, 0);
  
  // Category breakdown
  const categoryBreakdown: any = {};
  expenses.forEach(expense => {
    const catName = expense.category.name;
    categoryBreakdown[catName] = (categoryBreakdown[catName] || 0) + expense.amount;
  });
  
  return await prisma.monthlyExpenseSummary.upsert({
    where: {
      societyId_month_year: { societyId, month, year }
    },
    update: {
      totalExpenses,
      totalGST,
      totalTDS,
      netAmount,
      expenseCount: expenses.length,
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
      expenseCount: expenses.length,
      categoryBreakdown,
      lastCalculated: new Date()
    }
  });
}

export default router;
