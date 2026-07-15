import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  getLegalConsentStatus,
  type LegalConsentDb,
} from "./legalVersions";

type LatestRow = {
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: Date;
} | null;

function fakeDb(latest: LatestRow): LegalConsentDb {
  return {
    userLegalConsent: {
      async findFirst() {
        return latest;
      },
    },
  };
}

test("no prior consent → requiresAcceptance true, accepted versions null", async () => {
  const status = await getLegalConsentStatus(fakeDb(null), "user1");
  assert.equal(status.requiresAcceptance, true);
  assert.equal(status.acceptedTermsVersion, null);
  assert.equal(status.acceptedPrivacyVersion, null);
  assert.equal(status.acceptedAt, null);
  assert.equal(status.currentTermsVersion, CURRENT_TERMS_VERSION);
  assert.equal(status.currentPrivacyVersion, CURRENT_PRIVACY_VERSION);
});

test("latest consent matches current versions → requiresAcceptance false", async () => {
  const acceptedAt = new Date("2026-07-07T10:00:00.000Z");
  const status = await getLegalConsentStatus(
    fakeDb({
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
      acceptedAt,
    }),
    "user1",
  );
  assert.equal(status.requiresAcceptance, false);
  assert.equal(status.acceptedTermsVersion, CURRENT_TERMS_VERSION);
  assert.equal(status.acceptedAt, acceptedAt.toISOString());
});

test("stale terms version → requiresAcceptance true", async () => {
  const status = await getLegalConsentStatus(
    fakeDb({
      termsVersion: "2025-01-01",
      privacyVersion: CURRENT_PRIVACY_VERSION,
      acceptedAt: new Date(),
    }),
    "user1",
  );
  assert.equal(status.requiresAcceptance, true);
});

test("stale privacy version → requiresAcceptance true", async () => {
  const status = await getLegalConsentStatus(
    fakeDb({
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: "2025-01-01",
      acceptedAt: new Date(),
    }),
    "user1",
  );
  assert.equal(status.requiresAcceptance, true);
});
