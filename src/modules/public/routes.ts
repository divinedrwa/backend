import { Router } from "express";
import { Prisma, PushPlatform, SocietyStatus } from "@prisma/client";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { cacheMiddleware } from "../../middlewares/cache";
import { requireAuth } from "../../middlewares/auth";
import { isMissingColumnError } from "../../lib/schemaChecks";
import { societyIsSandboxColumnExists } from "../../lib/sandboxSociety";
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  PRIVACY_URL,
  TERMS_URL,
} from "../../lib/legalVersions";

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
    const hasSandboxFlag = await societyIsSandboxColumnExists();
    const [rows, total] = await Promise.all([
      prisma.society.findMany({
        where,
        select: {
          id: true,
          name: true,
          address: true,
          status: true,
          ...(hasSandboxFlag ? { isSandbox: true } : {}),
        },
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
 * GET /api/public/legal-version — current Terms/Privacy versions + hosted URLs (no auth).
 * Lets clients render/link the docs before login. Per-user acceptance state is at
 * GET /api/legal/status (authenticated).
 */
router.get("/legal-version", cacheMiddleware(300), (_req, res) => {
  res.json({
    termsVersion: CURRENT_TERMS_VERSION,
    privacyVersion: CURRENT_PRIVACY_VERSION,
    termsUrl: TERMS_URL,
    privacyUrl: PRIVACY_URL,
  });
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
      res.setHeader("Cache-Control", "public, max-age=300");
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

/**
 * GET /api/public/society-appearance/:societyId — theme colors + splash image for
 * a society, WITHOUT auth. Used by the app at startup (splash/login, pre-login) so
 * the selected theme and uploaded splash appear before the user is authenticated.
 * Only non-sensitive appearance data is returned. Returns
 * { themeColors: {...} | null, splashUrl: string | null }.
 */
router.get("/society-appearance/:societyId", async (req, res, next) => {
  try {
    const { societyId } = req.params;
    try {
      const society = await prisma.society.findUnique({
        where: { id: societyId },
        select: { themeColors: true, splashUrl: true },
      });
      res.setHeader("Cache-Control", "public, max-age=300");
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
