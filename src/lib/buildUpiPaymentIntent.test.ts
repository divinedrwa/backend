import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildUpiPaymentIntentUri,
  resolveUpiPayUriFromPayload,
} from "./buildUpiPaymentIntent.js";

describe("resolveUpiPayUriFromPayload", () => {
  it("returns direct upi://pay URI", () => {
    const uri = "upi://pay?pa=test@mahb&pn=Society&mc=0000";
    assert.equal(resolveUpiPayUriFromPayload(uri), uri);
  });

  it("builds URI from EMVCo via embedded pa/mc fallback", () => {
    const emvco =
      "00020101021126360012UP080020877102000000" +
      "pa=test@mahb&pn=Foo&mc=1234&tid=TXN1" +
      "5204000053033565802IN6304ABCD";
    const resolved = resolveUpiPayUriFromPayload(emvco);
    assert.ok(resolved);
    const url = new URL(resolved!);
    assert.equal(url.searchParams.get("pa"), "test@mahb");
    assert.equal(url.searchParams.get("mc"), "1234");
  });
});

describe("buildUpiPaymentIntentUri", () => {
  it("replays a signed merchant QR verbatim, setting only am/cu/tn", () => {
    // A real bank QR carries mc/mode and a base64 sign (contains +, /, =).
    const sign = "abc+def/ghi==";
    const intent = buildUpiPaymentIntentUri({
      upiPayUri: `upi://pay?pa=divine@mahb&pn=DIVINE&mc=5411&mode=01&orgid=159761&sign=${sign}`,
      vpa: "divine@mahb",
      payeeName: "DIVINE",
      amount: 1500,
      remark: "Maintenance 6/2026",
    });

    // Merchant identity + signature preserved so the payment stays P2M.
    assert.match(intent, /(?:\?|&)mc=5411(?:&|$)/);
    assert.match(intent, /(?:\?|&)mode=01(?:&|$)/);
    assert.match(intent, /(?:\?|&)orgid=159761(?:&|$)/);
    // sign must be byte-identical — never decoded/re-encoded.
    assert.match(intent, new RegExp(`sign=${sign.replace(/[+/]/g, "\\$&")}(?:&|$)`));

    const url = new URL(intent);
    assert.equal(url.searchParams.get("pa"), "divine@mahb");
    assert.equal(url.searchParams.get("am"), "1500.00");
    assert.equal(url.searchParams.get("cu"), "INR");
    assert.equal(url.searchParams.get("tn"), "Maintenance 6-2026");
  });

  it("falls back to a plain P2P intent when there is no signed payload", () => {
    const intent = buildUpiPaymentIntentUri({
      vpa: "someone@okhdfcbank",
      payeeName: "Someone",
      amount: 250,
      remark: "Maintenance 6/2026",
    });
    const url = new URL(intent);
    assert.equal(url.searchParams.get("pa"), "someone@okhdfcbank");
    assert.equal(url.searchParams.get("am"), "250.00");
    assert.equal(url.searchParams.get("mc"), null);
  });
});
