import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUpiQrPayload } from "./decodeUpiQrImage.js";

describe("parseUpiQrPayload", () => {
  it("parses standard upi://pay URI", () => {
    const result = parseUpiQrPayload(
      "upi://pay?pa=society@okhdfc&pn=Divine%20Residency&cu=INR",
    );
    assert.equal(result.vpa, "society@okhdfc");
    assert.equal(result.payeeName, "Divine Residency");
    assert.equal(result.hasFixedAmount, false);
  });

  it("parses upi://pay with fixed amount", () => {
    const result = parseUpiQrPayload("upi://pay?pa=test@ybl&am=500.00&pn=Society");
    assert.equal(result.vpa, "test@ybl");
    assert.equal(result.hasFixedAmount, true);
    assert.equal(result.fixedAmount, "500.00");
  });

  it("rejects non-UPI payloads", () => {
    assert.throws(() => parseUpiQrPayload("https://example.com"), /not a valid UPI/);
  });

  it("rejects upi URI without valid VPA", () => {
    assert.throws(() => parseUpiQrPayload("upi://pay?pn=Test"), /valid UPI VPA/);
  });
});
