import { Router } from "express";
import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { getPagination, paginationMeta } from "../../lib/pagination";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN, UserRole.RESIDENT));

// ─── GET /residents/special-projects — List projects with my contribution ─

router.get("/special-projects", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const villaId = req.auth!.villaId;
    const pagination = getPagination(req);
    const { status } = req.query;

    const where: Prisma.SpecialProjectWhereInput = { societyId };
    if (typeof status === "string" && status) {
      where.status = status as Prisma.EnumSpecialProjectStatusFilter;
    }

    const [projects, total] = await Promise.all([
      prisma.specialProject.findMany({
        where,
        select: {
          id: true,
          title: true,
          description: true,
          type: true,
          status: true,
          targetAmount: true,
          totalCollected: true,
          totalExpenses: true,
          createdAt: true,
          _count: { select: { contributions: true, expenses: true } },
          // Include only my villa's contribution if I have a villa
          contributions: villaId
            ? {
                where: { villaId },
                select: {
                  id: true,
                  amount: true,
                  paidAmount: true,
                  status: true,
                  dueDate: true,
                },
              }
            : false,
        },
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.specialProject.count({ where }),
    ]);

    // Flatten myContribution
    const mapped = projects.map((p) => {
      const { contributions, ...rest } = p;
      return {
        ...rest,
        myContribution: Array.isArray(contributions) && contributions.length > 0
          ? contributions[0]
          : null,
      };
    });

    res.json({ projects: mapped, ...paginationMeta(total, mapped.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// ─── GET /residents/special-projects/:id — Project detail + my contribution ─

router.get("/special-projects/:id", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const villaId = req.auth!.villaId;
    const { id } = req.params;

    const project = await prisma.specialProject.findFirst({
      where: { id, societyId },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        status: true,
        targetAmount: true,
        totalCollected: true,
        totalExpenses: true,
        createdAt: true,
        updatedAt: true,
        createdBy: { select: { id: true, name: true } },
        _count: { select: { contributions: true, expenses: true } },
      },
    });

    if (!project) return res.status(404).json({ error: "Project not found" });

    // Fetch my contribution with payment history
    let myContribution = null;
    if (villaId) {
      myContribution = await prisma.projectContribution.findUnique({
        where: { projectId_villaId: { projectId: id, villaId } },
        include: {
          payments: {
            select: {
              id: true,
              amount: true,
              method: true,
              reference: true,
              paidAt: true,
              createdAt: true,
            },
            orderBy: { paidAt: "desc" },
          },
        },
      });
    }

    res.json({ project, myContribution });
  } catch (error) {
    next(error);
  }
});

// ─── GET /residents/special-projects/:id/expenses — View project expenses ─

router.get("/special-projects/:id/expenses", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { id } = req.params;
    const pagination = getPagination(req);

    const project = await prisma.specialProject.findFirst({
      where: { id, societyId },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });

    const where: Prisma.ProjectExpenseWhereInput = { projectId: id };
    const [expenses, total] = await Promise.all([
      prisma.projectExpense.findMany({
        where,
        select: {
          id: true,
          description: true,
          amount: true,
          vendor: true,
          receiptUrl: true,
          expenseDate: true,
          createdAt: true,
        },
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

export default router;
