import { Router } from "express";
import { Prisma, PushPlatform, SocietyStatus } from "@prisma/client";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { cacheMiddleware } from "../../middlewares/cache";
import { requireAuth } from "../../middlewares/auth";
import { isMissingColumnError } from "../../lib/schemaChecks";

const router = Router();

function parseSocietySearch(req: { query: Record<string, unknown> }): string | undefined {
  const raw =
    (typeof req.query.search === "string" ? req.query.search : "") ||
    (typeof req.query.q === "string" ? req.query.q : "");
  const q = raw.trim();
  return q.length > 0 ? q : undefined;
}

/**
 * GET /api/public/societies — list societies for login pickers (no auth).
 */
router.get("/societies", cacheMiddleware(300), async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const search = parseSocietySearch(req);
    const where: Prisma.SocietyWhereInput = {
      archivedAt: null,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { address: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
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

/**
 * GET /api/public/society-theme — current society's theme colors + splash image
 * (any authenticated role). Returns { themeColors: {...} | null, splashUrl: string | null }.
 */
router.get("/society-theme", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    try {
      const society = await prisma.society.findUnique({
        where: { id: societyId },
        select: { themeColors: true, splashUrl: true },
      });
      return res.json({
        themeColors: society?.themeColors ?? null,
        splashUrl: society?.splashUrl ?? null,
      });
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      return res.json({ themeColors: null, splashUrl: null });
    }
  } catch (e) {
    next(e);
  }
});

export default router;
