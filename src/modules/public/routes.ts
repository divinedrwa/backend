import { Router } from "express";
import { SocietyStatus } from "@prisma/client";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";

const router = Router();

/**
 * GET /api/public/societies — list societies for login pickers (no auth).
 */
router.get("/societies", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where = { archivedAt: null };
    /** All tenants for login pickers (mobile + web). Exclude archived societies. */
    const [rows, total] = await Promise.all([
      prisma.society.findMany({
        where,
        select: { id: true, name: true, address: true, status: true },
        orderBy: { name: "asc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.society.count({ where }),
    ]);
    const societies = [...rows].sort((a, b) => {
      if (a.status === b.status) return a.name.localeCompare(b.name);
      return a.status === SocietyStatus.ACTIVE ? -1 : 1;
    });
    res.json({ societies, ...paginationMeta(total, societies.length, pagination) });
  } catch (e) {
    next(e);
  }
});

export default router;
