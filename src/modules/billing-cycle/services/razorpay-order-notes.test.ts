import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRazorpayMaintenanceOrderNotes,
  formatInrAmountForNote,
  formatVillaLabel,
  parseRazorpayOrderNoteAmounts,
  truncateRazorpayNoteValue,
  RAZORPAY_NOTE_MAX_KEYS,
  RAZORPAY_NOTE_MAX_VALUE_LEN,
} from "./razorpay-order-notes";

describe("razorpay-order-notes", () => {
  it("truncates long note values", () => {
    const long = "x".repeat(300);
    const out = truncateRazorpayNoteValue(long);
    assert.equal(out.length, RAZORPAY_NOTE_MAX_VALUE_LEN);
    assert.ok(out.endsWith("…"));
  });

  it("formats INR amounts in rupees for notes", () => {
    assert.equal(formatInrAmountForNote(100), "100");
    assert.equal(formatInrAmountForNote(1023.6), "1023.6");
    assert.equal(formatInrAmountForNote(2.5), "2.5");
  });

  it("formats villa with block", () => {
    assert.equal(formatVillaLabel({ villaNumber: "101", block: "A" }), "A - 101");
    assert.equal(formatVillaLabel({ villaNumber: "202", block: null }), "202");
    assert.equal(formatVillaLabel(null), "");
  });

  it("stores rupee amounts in Razorpay notes", () => {
    const notes = buildRazorpayMaintenanceOrderNotes({
      societyId: "soc1",
      cycleId: "cyc1",
      userId: "usr1",
      cycleKey: "2026-04",
      cycleTitle: "April 2026 Maintenance",
      breakup: {
        maintenanceAmount: 100,
        platformFee: 2,
        platformFeeGst: 0.36,
        totalPayable: 102.36,
      },
      resident: {
        societyName: "Divine Residency",
        residentName: "Rajesh Kumar",
        residentEmail: "rajesh@example.com",
        residentPhone: "9876543210",
        villaLabel: "B - 12",
      },
      payAllPending: true,
      pendingCycleCount: 3,
    });

    assert.equal(notes.maintenanceAmount, "100");
    assert.equal(notes.platformFee, "2");
    assert.equal(notes.platformFeeGst, "0.36");
    assert.equal(notes.totalPayable, "102.36");
    assert.equal(notes.maintenanceAmountPaise, undefined);
    assert.ok(Object.keys(notes).length <= RAZORPAY_NOTE_MAX_KEYS);
  });

  it("parses rupee notes and legacy paise notes", () => {
    assert.deepEqual(
      parseRazorpayOrderNoteAmounts({
        maintenanceAmount: "100",
        platformFee: "2",
        platformFeeGst: "0.36",
        totalPayable: "102.36",
      }),
      {
        maintenanceAmount: 100,
        platformFee: 2,
        platformFeeGst: 0.36,
        totalPayable: 102.36,
        expectedPaise: 10236,
      },
    );

    assert.deepEqual(
      parseRazorpayOrderNoteAmounts({
        maintenanceAmountPaise: "10000",
        platformFeePaise: "200",
        platformFeeGstPaise: "36",
      }),
      {
        maintenanceAmount: 100,
        platformFee: 2,
        platformFeeGst: 0.36,
        totalPayable: 102.36,
        expectedPaise: 10236,
      },
    );
  });
});
