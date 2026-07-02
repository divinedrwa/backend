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

  it("preserves a real merchant QR (mc, encoded @, no sign) and adds amount", () => {
    // Exact shape of the society's Bank of Maharashtra merchant QR: pa has an
    // encoded @ (%40), mc marks it as a merchant, no signature (directory
    // lookup), variable amount. Must stay P2M so it dodges the P2P 24h cap.
    // Verified end-to-end 2026-07-01: mc/mode/purpose replayed byte-for-byte
    // → payment apps recognize the merchant and settle as P2M.
    const qr =
      "upi://pay?pa=bom260601340945%40mahb&pn=DIVINE+RESIDENCY+WEL&cu=INR&mc=2741&mode=01&purpose=00";
    const intent = buildUpiPaymentIntentUri({
      upiPayUri: qr,
      vpa: "bom260601340945@mahb",
      payeeName: "DIVINE RESIDENCY WEL",
      amount: 1500,
      remark: "Maintenance 6/2026",
    });
    // pa kept byte-for-byte (encoded @ preserved), mc/mode/purpose present → P2M.
    assert.match(intent, /pa=bom260601340945%40mahb(?:&|$)/);
    assert.match(intent, /(?:\?|&)mc=2741(?:&|$)/);
    assert.match(intent, /(?:\?|&)mode=01(?:&|$)/);
    assert.match(intent, /(?:\?|&)purpose=00(?:&|$)/);
    assert.match(intent, /(?:\?|&)am=1500\.00(?:&|$)/);
    // exactly one cu param (the stale one is replaced, not duplicated)
    assert.equal((intent.match(/(?:\?|&)cu=/g) ?? []).length, 1);
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
