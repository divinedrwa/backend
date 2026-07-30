import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildVisitorPublicPassUrl,
  createVisitorPublicPassToken,
  hashVisitorPublicPassToken,
  isValidVisitorPublicPassToken,
  resolveVisitorPublicPassStatus,
} from "./visitorPublicPass";

const activePass = {
  validFrom: new Date("2026-07-30T09:00:00.000Z"),
  validUntil: new Date("2026-07-30T12:00:00.000Z"),
  isActive: true,
  isUsed: false,
  isRecurring: false,
  maxUses: null,
  usedCount: 0,
};
const now = new Date("2026-07-30T10:00:00.000Z");

describe("visitorPublicPass", () => {
  it("creates a valid token and stores only a deterministic SHA-256 hash", () => {
    const issued = createVisitorPublicPassToken();
    assert.equal(isValidVisitorPublicPassToken(issued.rawToken), true);
    assert.equal(issued.tokenHash.length, 64);
    assert.equal(
      issued.tokenHash,
      hashVisitorPublicPassToken(issued.rawToken),
    );
    assert.notEqual(issued.rawToken, issued.tokenHash);
  });

  it("rejects malformed public tokens", () => {
    assert.equal(isValidVisitorPublicPassToken("123456"), false);
    assert.equal(isValidVisitorPublicPassToken("x".repeat(500)), false);
    assert.equal(isValidVisitorPublicPassToken("x".repeat(43)), true);
  });

  it("builds a pass URL from the dedicated base URL", () => {
    const old = process.env.VISITOR_PASS_BASE_URL;
    process.env.VISITOR_PASS_BASE_URL = "https://admin.example.com/";
    try {
      assert.equal(
        buildVisitorPublicPassUrl("x".repeat(43)),
        `https://admin.example.com/visit/${"x".repeat(43)}`,
      );
    } finally {
      if (old === undefined) delete process.env.VISITOR_PASS_BASE_URL;
      else process.env.VISITOR_PASS_BASE_URL = old;
    }
  });

  it("resolves all public lifecycle states without leaking admission logic", () => {
    assert.equal(resolveVisitorPublicPassStatus(activePass, now), "ACTIVE");
    assert.equal(
      resolveVisitorPublicPassStatus({ ...activePass, isActive: false }, now),
      "CANCELLED",
    );
    assert.equal(
      resolveVisitorPublicPassStatus(
        { ...activePass, validFrom: new Date("2026-07-30T11:00:00.000Z") },
        now,
      ),
      "NOT_YET_VALID",
    );
    assert.equal(
      resolveVisitorPublicPassStatus(
        { ...activePass, validUntil: new Date("2026-07-30T10:00:00.000Z") },
        now,
      ),
      "EXPIRED",
    );
    assert.equal(
      resolveVisitorPublicPassStatus({ ...activePass, isUsed: true }, now),
      "USED",
    );
    assert.equal(
      resolveVisitorPublicPassStatus(
        {
          ...activePass,
          isRecurring: true,
          maxUses: 2,
          usedCount: 2,
        },
        now,
      ),
      "USED",
    );
  });
});
