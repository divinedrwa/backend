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
  it("builds a plain P2P intent (drops merchant fields) and sets amount", () => {
    const intent = buildUpiPaymentIntentUri({
      upiPayUri: "upi://pay?pa=divine@mahb&pn=DIVINE&mc=5411&tid=TXN1&mode=02",
      vpa: "divine@mahb",
      payeeName: "DIVINE",
      amount: 1500,
      remark: "Maintenance 6/2026",
    });
    const url = new URL(intent);
    assert.equal(url.searchParams.get("pa"), "divine@mahb");
    assert.equal(url.searchParams.get("pn"), "DIVINE");
    assert.equal(url.searchParams.get("am"), "1500.00");
    assert.equal(url.searchParams.get("tn"), "Maintenance 6-2026");
    assert.equal(url.searchParams.get("cu"), "INR");
    // Merchant / signed-intent fields must NOT survive — they break third-party
    // UPI apps when the reconstructed URI has no valid signature.
    assert.equal(url.searchParams.get("mc"), null);
    assert.equal(url.searchParams.get("tid"), null);
    assert.equal(url.searchParams.get("mode"), null);
  });
});
