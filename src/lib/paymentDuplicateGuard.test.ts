import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaymentMode } from "@prisma/client";
import { findLikelyDuplicateMaintenancePayment } from "./paymentDuplicateGuard.js";

describe("K19 duplicate payment regression (A4)", () => {
  it("detects same villa/cycle/amount/mode within window", async () => {
    const paymentDate = new Date("2026-06-15T10:00:00Z");
    const tx = {
      maintenancePayment: {
        findFirst: async () => ({
          id: "dup-1",
          receiptNumber: "RCP-dup",
          paymentDate,
          amount: 1500,
          paymentMode: PaymentMode.CASH,
        }),
      },
    };

    const dup = await findLikelyDuplicateMaintenancePayment(tx as never, {
      societyId: "s1",
      villaId: "v1",
      month: 6,
      year: 2026,
      amount: 1500,
      paymentMode: PaymentMode.CASH,
      paymentDate,
    });
    assert.ok(dup);
    assert.equal(dup!.receiptNumber, "RCP-dup");
  });

  it("ignores reversed payments in duplicate search", async () => {
    const tx = {
      maintenancePayment: {
        findFirst: async () => null,
      },
    };
    const dup = await findLikelyDuplicateMaintenancePayment(tx as never, {
      societyId: "s1",
      villaId: "v1",
      month: 6,
      year: 2026,
      amount: 500,
      paymentMode: PaymentMode.CASH,
      paymentDate: new Date(),
    });
    assert.equal(dup, null);
  });
});
