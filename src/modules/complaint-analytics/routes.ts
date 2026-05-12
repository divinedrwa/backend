import { Prisma, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifyResidentsComplaintStatusChanged } from "../../services/complaintStatusNotification.service";

const router = Router();

type ComplaintCategoryStats = {
  category: string;
  totalCount: number;
  resolvedCount: number;
  pendingCount: number;
  inProgressCount: number;
  totalResolutionTime: number;
  resolvedWithTimeCount: number;
};

type ComplaintTrendStats = {
  month: string;
  totalComplaints: number;
  resolvedComplaints: number;
  totalResolutionTime: number;
  resolvedWithTimeCount: number;
};

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

// GET /api/complaint-analytics/summary
// Get overall complaint statistics with optional date range
router.get("/summary", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { startDate, endDate, days = "30" } = req.query;
    let periodStart: Date | null = null;
    let periodEnd: Date | null = null;

    // Calculate date range
    let dateFilter: Prisma.ComplaintWhereInput = {};
    if (startDate && endDate) {
      periodStart = new Date(startDate as string);
      periodEnd = new Date(endDate as string);
      dateFilter = {
        createdAt: {
          gte: periodStart,
          lte: periodEnd,
        },
      };
    } else {
      const daysAgo = parseInt(days as string) || 30;
      periodStart = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      periodEnd = new Date();
      dateFilter = {
        createdAt: {
          gte: periodStart,
        },
      };
    }

    // Get all complaints in date range
    const complaints = await prisma.complaint.findMany({
      where: {
        societyId,
        ...dateFilter,
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            ownerName: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Calculate statistics
    const totalComplaints = complaints.length;
    const resolvedCount = complaints.filter((c) => c.status === "RESOLVED" || c.status === "CLOSED").length;
    const inProgressCount = complaints.filter((c) => c.status === "IN_PROGRESS").length;
    const pendingCount = complaints.filter((c) => c.status === "OPEN").length;

    const resolutionRate = totalComplaints > 0 
      ? Math.round((resolvedCount / totalComplaints) * 100) 
      : 0;

    // Calculate average resolution time (for resolved complaints)
    const resolvedComplaints = complaints.filter((c) => c.status === "RESOLVED");
    let avgResolutionTime = 0;
    
    if (resolvedComplaints.length > 0) {
      const totalResolutionTime = resolvedComplaints.reduce((sum, c) => {
        if (c.resolvedAt) {
          const timeDiff = new Date(c.resolvedAt).getTime() - new Date(c.createdAt).getTime();
          return sum + timeDiff / (1000 * 60 * 60 * 24); // Convert to days
        }
        return sum;
      }, 0);
      avgResolutionTime = totalResolutionTime / resolvedComplaints.length;
    }

    return res.json({
      period: {
        startDate: periodStart,
        endDate: periodEnd,
        days: parseInt(days as string) || 30,
      },
      summary: {
        totalComplaints,
        resolvedCount,
        inProgressCount,
        pendingCount,
        resolutionRate,
        avgResolutionTime: Math.round(avgResolutionTime * 10) / 10, // Round to 1 decimal
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/complaint-analytics/by-category
// Get complaints breakdown by category
router.get("/by-category", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { days = "30" } = req.query;

    const daysAgo = parseInt(days as string) || 30;
    const dateFilter = {
      createdAt: {
        gte: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
      },
    };

    // Get all complaints
    const complaints = await prisma.complaint.findMany({
      where: {
        societyId,
        ...dateFilter,
      },
      select: {
        category: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
      },
    });

    // Group by category
    const categoryMap = new Map<string, ComplaintCategoryStats>();

    complaints.forEach((complaint) => {
      const category = complaint.category || "Other";
      
      if (!categoryMap.has(category)) {
        categoryMap.set(category, {
          category,
          totalCount: 0,
          resolvedCount: 0,
          pendingCount: 0,
          inProgressCount: 0,
          totalResolutionTime: 0,
          resolvedWithTimeCount: 0,
        });
      }

      const catData = categoryMap.get(category)!;
      catData.totalCount++;

      if (complaint.status === "RESOLVED") {
        catData.resolvedCount++;
        
        if (complaint.resolvedAt) {
          const timeDiff = new Date(complaint.resolvedAt).getTime() - new Date(complaint.createdAt).getTime();
          catData.totalResolutionTime += timeDiff / (1000 * 60 * 60 * 24);
          catData.resolvedWithTimeCount++;
        }
      } else if (complaint.status === "IN_PROGRESS") {
        catData.inProgressCount++;
      } else {
        catData.pendingCount++;
      }
    });

    // Calculate averages and format response
    const categoryStats = Array.from(categoryMap.values()).map((cat) => {
      const avgResolutionTime = cat.resolvedWithTimeCount > 0
        ? Math.round((cat.totalResolutionTime / cat.resolvedWithTimeCount) * 10) / 10
        : 0;

      const resolutionRate = cat.totalCount > 0
        ? Math.round((cat.resolvedCount / cat.totalCount) * 100)
        : 0;

      // Determine performance status
      let performanceStatus = "🟢 Good";
      if (avgResolutionTime > 5) {
        performanceStatus = "🔴 Slow";
      } else if (avgResolutionTime > 3) {
        performanceStatus = "🟡 Fair";
      }

      return {
        category: cat.category,
        totalCount: cat.totalCount,
        resolvedCount: cat.resolvedCount,
        pendingCount: cat.pendingCount,
        inProgressCount: cat.inProgressCount,
        avgResolutionTime,
        resolutionRate,
        performanceStatus,
      };
    });

    // Sort by total count descending
    categoryStats.sort((a, b) => b.totalCount - a.totalCount);

    return res.json({ categoryStats });
  } catch (error) {
    next(error);
  }
});

// GET /api/complaint-analytics/pending-list
// Get list of pending complaints that need attention
router.get("/pending-list", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { limit = "20" } = req.query;

    const pendingComplaints = await prisma.complaint.findMany({
      where: {
        societyId,
        status: {
          in: ["OPEN", "IN_PROGRESS"],
        },
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
            ownerName: true,
          },
        },
      },
      orderBy: { createdAt: "asc" }, // Oldest first
      take: parseInt(limit as string),
    });

    // Calculate days pending for each
    const complaintsWithAge = pendingComplaints.map((complaint) => {
      const daysPending = Math.floor(
        (Date.now() - new Date(complaint.createdAt).getTime()) / (1000 * 60 * 60 * 24)
      );

      let urgencyLevel = "normal";
      if (daysPending > 7) {
        urgencyLevel = "critical";
      } else if (daysPending > 3) {
        urgencyLevel = "high";
      }

      return {
        ...complaint,
        daysPending,
        urgencyLevel,
      };
    });

    return res.json({ pendingComplaints: complaintsWithAge });
  } catch (error) {
    next(error);
  }
});

// GET /api/complaint-analytics/trend
// Get complaint trend over time (monthly)
router.get("/trend", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { months = "6" } = req.query;

    const monthsCount = parseInt(months as string) || 6;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - monthsCount);
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);

    const complaints = await prisma.complaint.findMany({
      where: {
        societyId,
        createdAt: {
          gte: startDate,
        },
      },
      select: {
        createdAt: true,
        status: true,
        resolvedAt: true,
      },
    });

    // Group by month
    const monthMap = new Map<string, ComplaintTrendStats>();

    complaints.forEach((complaint) => {
      const date = new Date(complaint.createdAt);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, {
          month: monthKey,
          totalComplaints: 0,
          resolvedComplaints: 0,
          totalResolutionTime: 0,
          resolvedWithTimeCount: 0,
        });
      }

      const monthData = monthMap.get(monthKey)!;
      monthData.totalComplaints++;

      if (complaint.status === "RESOLVED") {
        monthData.resolvedComplaints++;
        
        if (complaint.resolvedAt) {
          const timeDiff = new Date(complaint.resolvedAt).getTime() - date.getTime();
          monthData.totalResolutionTime += timeDiff / (1000 * 60 * 60 * 24);
          monthData.resolvedWithTimeCount++;
        }
      }
    });

    // Fill in missing months and calculate averages
    const trendData = [];
    const currentDate = new Date(startDate);
    const endDate = new Date();

    while (currentDate <= endDate) {
      const monthKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}`;
      const monthData = monthMap.get(monthKey) || {
        month: monthKey,
        totalComplaints: 0,
        resolvedComplaints: 0,
        totalResolutionTime: 0,
        resolvedWithTimeCount: 0,
      };

      const avgResolutionTime = monthData.resolvedWithTimeCount > 0
        ? Math.round((monthData.totalResolutionTime / monthData.resolvedWithTimeCount) * 10) / 10
        : 0;

      const resolutionRate = monthData.totalComplaints > 0
        ? Math.round((monthData.resolvedComplaints / monthData.totalComplaints) * 100)
        : 0;

      trendData.push({
        month: monthKey,
        totalComplaints: monthData.totalComplaints,
        resolvedComplaints: monthData.resolvedComplaints,
        avgResolutionTime,
        resolutionRate,
      });

      currentDate.setMonth(currentDate.getMonth() + 1);
    }

    return res.json({ trendData });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/complaint-analytics/quick-update/:id
// Quick status update for complaints
const quickUpdateSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
  adminNotes: z.string().optional(),
});

router.patch(
  "/quick-update/:id",
  validateBody(quickUpdateSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { societyId } = req.auth!;
      const { status, adminNotes } = req.body as z.infer<typeof quickUpdateSchema>;

      // Check if complaint exists
      const complaint = await prisma.complaint.findFirst({
        where: {
          id,
          societyId,
        },
      });

      if (!complaint) {
        return res.status(404).json({ message: "Complaint not found" });
      }

      const previousStatus = complaint.status;

      // Update complaint
      const updateData: Prisma.ComplaintUpdateInput = {
        status,
      };

      if (adminNotes) {
        updateData.adminNotes = adminNotes;
      }

      if (status === "RESOLVED" && !complaint.resolvedAt) {
        updateData.resolvedAt = new Date();
      }

      const updatedComplaint = await prisma.complaint.update({
        where: { id },
        data: updateData,
        include: {
          villa: {
            select: {
              villaNumber: true,
              ownerName: true,
            },
          },
        },
      });

      if (previousStatus !== status) {
        void notifyResidentsComplaintStatusChanged({
          complaintId: id,
          title: updatedComplaint.title,
          villaId: updatedComplaint.villaId,
          societyId,
          residentId: updatedComplaint.residentId,
          previousStatus,
          newStatus: status,
        });
      }

      return res.json({
        message: "Complaint updated successfully",
        complaint: updatedComplaint,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
