import { Router } from "express";
import { SocietyStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";

const router = Router();

/**
 * GET /api/public/societies — list societies for login pickers (no auth).
 */
router.get("/societies", async (_req, res, next) => {
  try {
    /** All tenants for login pickers (mobile + web). Clients should prefer ACTIVE; INACTIVE may be shown disabled. */
    const rows = await prisma.society.findMany({
      select: { id: true, name: true, address: true, status: true },
      orderBy: { name: "asc" },
    });
    const societies = [...rows].sort((a, b) => {
      if (a.status === b.status) return a.name.localeCompare(b.name);
      return a.status === SocietyStatus.ACTIVE ? -1 : 1;
    });
    res.json({ societies });
  } catch (e) {
    next(e);
  }
});

export default router;
