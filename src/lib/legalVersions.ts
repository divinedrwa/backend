/**
 * L2 — consent & terms versioning.
 *
 * Single source of truth for the CURRENT legal document versions. A "version" is the
 * `Last updated` date string in the corresponding doc under `docs/legal/` (and the copies
 * shipped in `divine_app/assets/legal/`). When you publish new legal text, bump these to
 * match the new `Last updated` date — that makes every user's previously-accepted version
 * stale and triggers re-acceptance in updated clients.
 *
 * Overridable via env (LEGAL_TERMS_VERSION / LEGAL_PRIVACY_VERSION) so ops can roll a new
 * version without a code deploy if needed; defaults track the doc dates.
 *
 * Non-breaking by design: the version info is surfaced additively on the auth response and
 * via new /legal endpoints. Older mobile builds that don't read `requiresAcceptance` keep
 * working exactly as before (historical implicit acceptance); only updated clients gate on it.
 */

export const CURRENT_TERMS_VERSION = process.env.LEGAL_TERMS_VERSION?.trim() || "2026-07-18";
export const CURRENT_PRIVACY_VERSION =
  process.env.LEGAL_PRIVACY_VERSION?.trim() || "2026-07-18";

/** Public URLs for the hosted docs, if configured (mirrors the mobile app's dart-defines). */
export const TERMS_URL = process.env.TERMS_AND_CONDITIONS_URL?.trim() || null;
export const PRIVACY_URL = process.env.PRIVACY_POLICY_URL?.trim() || null;

export interface LegalConsentStatus {
  currentTermsVersion: string;
  currentPrivacyVersion: string;
  acceptedTermsVersion: string | null;
  acceptedPrivacyVersion: string | null;
  acceptedAt: string | null;
  /** True when the user has not accepted BOTH current versions and must re-accept. */
  requiresAcceptance: boolean;
}

/** Minimal Prisma surface needed here — keeps the helper unit-testable with a fake client. */
export interface LegalConsentDb {
  userLegalConsent: {
    findFirst(args: {
      where: { userId: string };
      orderBy: { acceptedAt: "desc" };
      select: { termsVersion: true; privacyVersion: true; acceptedAt: true };
    }): Promise<{
      termsVersion: string;
      privacyVersion: string;
      acceptedAt: Date;
    } | null>;
  };
}

/**
 * Compute the current consent status for a user from their most recent acceptance row.
 * A user with no consent row (every existing user before this feature shipped) correctly
 * resolves to `requiresAcceptance: true`.
 */
export async function getLegalConsentStatus(
  db: LegalConsentDb,
  userId: string,
): Promise<LegalConsentStatus> {
  const latest = await db.userLegalConsent.findFirst({
    where: { userId },
    orderBy: { acceptedAt: "desc" },
    select: { termsVersion: true, privacyVersion: true, acceptedAt: true },
  });

  const acceptedTermsVersion = latest?.termsVersion ?? null;
  const acceptedPrivacyVersion = latest?.privacyVersion ?? null;

  const requiresAcceptance =
    acceptedTermsVersion !== CURRENT_TERMS_VERSION ||
    acceptedPrivacyVersion !== CURRENT_PRIVACY_VERSION;

  return {
    currentTermsVersion: CURRENT_TERMS_VERSION,
    currentPrivacyVersion: CURRENT_PRIVACY_VERSION,
    acceptedTermsVersion,
    acceptedPrivacyVersion,
    acceptedAt: latest?.acceptedAt.toISOString() ?? null,
    requiresAcceptance,
  };
}
