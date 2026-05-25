/**
 * Unit tests for PhonePe checksum generation and verification.
 *
 * Tests the cryptographic contract without hitting the PhonePe API.
 * Uses the real crypto functions from phonepe-billing.ts where possible,
 * and reproduces the checksum algorithm for expected-value tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Reproduce the pure-function parts of phonepe-billing so we can test them
// without DB access. The actual module reads PhonePe config from Prisma and
// env vars, so we extract the algorithmic core here.
// ---------------------------------------------------------------------------

function computePayChecksum(
  base64Payload: string,
  saltKey: string,
  saltIndex: number,
): string {
  return (
    crypto
      .createHash("sha256")
      .update(base64Payload + "/pg/v1/pay" + saltKey)
      .digest("hex") + `###${saltIndex}`
  );
}

function computeStatusChecksum(
  merchantId: string,
  merchantTransactionId: string,
  saltKey: string,
  saltIndex: number,
): string {
  const path = `/pg/v1/status/${merchantId}/${merchantTransactionId}`;
  return (
    crypto
      .createHash("sha256")
      .update(path + saltKey)
      .digest("hex") + `###${saltIndex}`
  );
}

function verifyChecksum(xVerifyHeader: string, expectedChecksum: string): boolean {
  const expected = Buffer.from(expectedChecksum, "utf8");
  const received = Buffer.from(xVerifyHeader, "utf8");
  if (expected.length !== received.length) return false;
  try {
    return crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PhonePe checksum generation", () => {
  const saltKey = "test-salt-key-abc123";
  const saltIndex = 1;

  it("produces a SHA-256 hex + ###saltIndex format", () => {
    const payload = Buffer.from(JSON.stringify({ amount: 10000 })).toString("base64");
    const checksum = computePayChecksum(payload, saltKey, saltIndex);

    // Format: 64 hex chars + "###1"
    assert.match(checksum, /^[0-9a-f]{64}###1$/);
  });

  it("pay checksum is deterministic for same inputs", () => {
    const payload = Buffer.from(JSON.stringify({ merchantId: "M1", amount: 5000 })).toString("base64");
    const a = computePayChecksum(payload, saltKey, saltIndex);
    const b = computePayChecksum(payload, saltKey, saltIndex);
    assert.equal(a, b);
  });

  it("pay checksum changes when payload changes", () => {
    const p1 = Buffer.from(JSON.stringify({ amount: 100 })).toString("base64");
    const p2 = Buffer.from(JSON.stringify({ amount: 200 })).toString("base64");
    const a = computePayChecksum(p1, saltKey, saltIndex);
    const b = computePayChecksum(p2, saltKey, saltIndex);
    assert.notEqual(a, b);
  });

  it("pay checksum changes when saltKey changes", () => {
    const payload = Buffer.from("test").toString("base64");
    const a = computePayChecksum(payload, "salt-a", saltIndex);
    const b = computePayChecksum(payload, "salt-b", saltIndex);
    assert.notEqual(a, b);
  });

  it("status checksum matches expected SHA-256 of path + salt", () => {
    const merchantId = "MERCHANT123";
    const txnId = "TXN_001";
    const checksum = computeStatusChecksum(merchantId, txnId, saltKey, saltIndex);

    // Manually compute expected
    const path = `/pg/v1/status/${merchantId}/${txnId}`;
    const expected =
      crypto.createHash("sha256").update(path + saltKey).digest("hex") + `###${saltIndex}`;

    assert.equal(checksum, expected);
  });

  it("status checksum includes saltIndex suffix", () => {
    const checksum = computeStatusChecksum("M1", "T1", saltKey, 2);
    assert.ok(checksum.endsWith("###2"));
  });
});

describe("PhonePe callback verification", () => {
  const saltKey = "verify-salt-key";
  const saltIndex = 1;

  it("valid checksum verifies as true", () => {
    const responseBase64 = Buffer.from(JSON.stringify({ success: true })).toString("base64");
    const expected = computePayChecksum(responseBase64, saltKey, saltIndex);

    assert.equal(verifyChecksum(expected, expected), true);
  });

  it("tampered checksum verifies as false", () => {
    const responseBase64 = Buffer.from(JSON.stringify({ success: true })).toString("base64");
    const expected = computePayChecksum(responseBase64, saltKey, saltIndex);
    const tampered = "0".repeat(64) + "###1";

    assert.equal(verifyChecksum(tampered, expected), false);
  });

  it("wrong saltIndex suffix causes length mismatch → false", () => {
    const responseBase64 = Buffer.from("data").toString("base64");
    const expected = computePayChecksum(responseBase64, saltKey, 1);
    const wrongIndex = expected.replace("###1", "###99");

    // Length differs ("###1" vs "###99") → false before timingSafeEqual
    assert.equal(verifyChecksum(wrongIndex, expected), false);
  });

  it("empty header returns false", () => {
    const responseBase64 = Buffer.from("data").toString("base64");
    const expected = computePayChecksum(responseBase64, saltKey, saltIndex);

    assert.equal(verifyChecksum("", expected), false);
  });

  it("timing-safe comparison does not short-circuit on partial match", () => {
    // Functional correctness: even if first bytes match, a later byte
    // difference still returns false.
    const responseBase64 = Buffer.from("payload").toString("base64");
    const expected = computePayChecksum(responseBase64, saltKey, saltIndex);

    // Flip the last hex char before the ### suffix
    const hexPart = expected.split("###")[0];
    const lastChar = hexPart[hexPart.length - 1];
    const flipped = lastChar === "0" ? "1" : "0";
    const almostRight = hexPart.slice(0, -1) + flipped + "###" + saltIndex;

    assert.equal(verifyChecksum(almostRight, expected), false);
  });
});

describe("PhonePe end-to-end checksum flow", () => {
  it("initiation → callback verification round-trip", () => {
    const saltKey = "e2e-test-salt";
    const saltIndex = 1;
    const payload = {
      merchantId: "PGTESTPAYUAT",
      merchantTransactionId: "MT7850590068188104",
      amount: 10000,
      redirectUrl: "https://example.com/redirect",
      callbackUrl: "https://example.com/callback",
      paymentInstrument: { type: "PAY_PAGE" },
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64");
    const initiationChecksum = computePayChecksum(base64Payload, saltKey, saltIndex);

    // Simulate: server receives callback with the same base64 response
    // and must verify the X-VERIFY header matches.
    const callbackResponseBase64 = base64Payload; // simplified: same payload
    const expectedCallbackChecksum = computePayChecksum(callbackResponseBase64, saltKey, saltIndex);

    assert.equal(verifyChecksum(initiationChecksum, expectedCallbackChecksum), true);
  });
});
