import { Router } from "express";
import { PushPlatform, SocietyStatus } from "@prisma/client";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { cacheMiddleware } from "../../middlewares/cache";

const router = Router();

/**
 * GET /api/public/societies — list societies for login pickers (no auth).
 */
router.get("/societies", cacheMiddleware(300), async (req, res, next) => {
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

/**
 * GET /api/public/app-version?platform=ANDROID — version config for in-app update checks.
 * No auth required. Returns { config: {...} | null }.
 */
router.get("/app-version", async (req, res, next) => {
  try {
    const platform = (typeof req.query.platform === "string" ? req.query.platform : "").toUpperCase().trim();
    if (!Object.values(PushPlatform).includes(platform as PushPlatform)) {
      res.status(400).json({ message: `Invalid platform. Must be one of: ${Object.values(PushPlatform).join(", ")}` });
      return;
    }
    const config = await prisma.appVersionConfig.findUnique({
      where: { platform: platform as PushPlatform },
      select: {
        latestVersion: true,
        minVersion: true,
        storeUrl: true,
        releaseNotes: true,
        updatedAt: true,
      },
    });
    res.json({ config: config ?? null });
  } catch (e) {
    next(e);
  }
});

export default router;
