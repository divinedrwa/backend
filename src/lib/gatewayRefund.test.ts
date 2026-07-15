import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaymentMode } from "@prisma/client";
import { attemptGatewayRefund } from "./gatewayRefund.js";

describe("attemptGatewayRefund", () => {
  it("returns NOT_GATEWAY_PAYMENT for cash", async () => {
    const r = await attemptGatewayRefund({
      societyId: "s1",
      transactionId: "tx1",
      amount: 100,
      paymentMode: PaymentMode.CASH,
    });
    assert.equal(r.attempted, false);
    assert.equal(r.message, "NOT_GATEWAY_PAYMENT");
  });

  it("returns MISSING_GATEWAY_TRANSACTION_ID when id absent", async () => {
    const r = await attemptGatewayRefund({
      societyId: "s1",
      transactionId: null,
      amount: 100,
      paymentMode: PaymentMode.ONLINE,
    });
    assert.equal(r.attempted, false);
    assert.equal(r.message, "MISSING_GATEWAY_TRANSACTION_ID");
  });
});
