import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichUpiVpaConfig, isUpiVpaConfigReady, validateUpiVpa } from "./validateUpiVpa.js";

describe("validateUpiVpa", () => {
  it("accepts a standard VPA", () => {
    const result = validateUpiVpa("  society@okhdfc  ");
    assert.equal(result.vpa, "society@okhdfc");
    assert.ok(result.validatedAt);
  });

  it("rejects invalid format", () => {
    assert.throws(() => validateUpiVpa("not-a-vpa"), /Invalid UPI VPA/);
    assert.throws(() => validateUpiVpa("@ybl"), /Invalid UPI VPA/);
  });

  it("enriches config with vpaValidatedAt", () => {
    const config = enrichUpiVpaConfig({ vpa: "test@ybl" });
    assert.equal(config.vpa, "test@ybl");
    assert.ok(config.vpaValidatedAt);
    assert.equal(isUpiVpaConfigReady(config), true);
  });

  it("preserves vpaValidatedAt when VPA unchanged", () => {
    const existing = { vpa: "test@ybl", vpaValidatedAt: "2026-01-01T00:00:00.000Z" };
    const config = enrichUpiVpaConfig({ vpa: "test@ybl" }, existing);
    assert.equal(config.vpaValidatedAt, "2026-01-01T00:00:00.000Z");
  });

  it("refreshes vpaValidatedAt when VPA changes", () => {
    const existing = { vpa: "old@ybl", vpaValidatedAt: "2026-01-01T00:00:00.000Z" };
    const config = enrichUpiVpaConfig({ vpa: "new@ybl" }, existing);
    assert.equal(config.vpa, "new@ybl");
    assert.notEqual(config.vpaValidatedAt, "2026-01-01T00:00:00.000Z");
  });
});
