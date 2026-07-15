import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  PRIVACY_URL,
  TERMS_URL,
  getLegalConsentStatus,
} from "../../lib/legalVersions";

/**
 * L2 — consent & terms versioning.
 *   GET  /api/legal/status   → current versions + whether the caller must (re-)accept
 *   POST /api/legal/accept   → record acceptance of the current versions (append-only)
 *
 * The unauthenticated current-version lookup lives at GET /api/public/legal-version so a
 * client can show the docs before login.
 */
const router = Router();

router.use(requireAuth);

// GET /api/legal/status — consent state for the authenticated user.
router.get("/status", async (req, res, next) => {
  try {
    const status = await getLegalConsentStatus(prisma, req.auth!.userId);
    return res.json({
      ...status,
      termsUrl: TERMS_URL,
      privacyUrl: PRIVACY_URL,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/legal/accept — record that the user accepts the CURRENT versions.
// The client must echo the versions it displayed; stale versions are rejected so a user
// can never be recorded as accepting text they weren't shown.
const acceptSchema = z.object({
  termsVersion: z.string().trim().min(1),
  privacyVersion: z.string().trim().min(1),
  appVersion: z.string().trim().max(64).optional(),
});

router.post("/accept", validateBody(acceptSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof acceptSchema>;

    if (
      body.termsVersion !== CURRENT_TERMS_VERSION ||
      body.privacyVersion !== CURRENT_PRIVACY_VERSION
    ) {
      return res.status(409).json({
        message: "Legal documents were updated. Please review and accept the current version.",
        currentTermsVersion: CURRENT_TERMS_VERSION,
        currentPrivacyVersion: CURRENT_PRIVACY_VERSION,
      });
    }

    const forwardedFor = req.headers["x-forwarded-for"];
    const ipAddress =
      (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(",")[0]?.trim() ||
      req.ip ||
      null;
    const userAgentHeader = req.headers["user-agent"];
    const userAgent = (Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader) ?? null;

    await prisma.userLegalConsent.create({
      data: {
        userId: req.auth!.userId,
        termsVersion: CURRENT_TERMS_VERSION,
        privacyVersion: CURRENT_PRIVACY_VERSION,
        appVersion: body.appVersion ?? null,
        ipAddress: ipAddress ? ipAddress.slice(0, 128) : null,
        userAgent: userAgent ? userAgent.slice(0, 512) : null,
      },
    });

    const status = await getLegalConsentStatus(prisma, req.auth!.userId);
    return res.status(201).json(status);
  } catch (err) {
    next(err);
  }
});

export default router;
