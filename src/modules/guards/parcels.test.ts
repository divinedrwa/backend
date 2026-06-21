import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeParcelDescription } from "./parcels";

describe("normalizeParcelDescription", () => {
  it("returns empty string when omitted", () => {
    assert.equal(normalizeParcelDescription(undefined), "");
    assert.equal(normalizeParcelDescription(null), "");
    assert.equal(normalizeParcelDescription(""), "");
    assert.equal(normalizeParcelDescription("   "), "");
  });

  it("trims non-empty notes", () => {
    assert.equal(normalizeParcelDescription("  Left at gate  "), "Left at gate");
  });
});
