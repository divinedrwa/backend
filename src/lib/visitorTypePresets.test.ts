import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultValidUntilForVisitorType,
  expectedCheckoutAtForVisitorType,
  visitorTypeLabel,
  VISITOR_TYPE_DEFAULT_VALIDITY_HOURS,
  VISITOR_TYPE_OVERSTAY_MINUTES,
} from "./visitorTypePresets";

describe("visitorTypePresets", () => {
  it("uses short windows for cab and delivery", () => {
    assert.equal(VISITOR_TYPE_DEFAULT_VALIDITY_HOURS.CAB, 2);
    assert.equal(VISITOR_TYPE_DEFAULT_VALIDITY_HOURS.DELIVERY, 4);
    assert.equal(VISITOR_TYPE_DEFAULT_VALIDITY_HOURS.GUEST, 24);
  });

  it("defaultValidUntilForVisitorType adds preset hours from base time", () => {
    const from = new Date("2026-07-29T10:00:00.000Z");
    const cab = defaultValidUntilForVisitorType("CAB", from);
    const delivery = defaultValidUntilForVisitorType("DELIVERY", from);
    const guest = defaultValidUntilForVisitorType("GUEST", from);
    assert.equal(cab.toISOString(), "2026-07-29T12:00:00.000Z");
    assert.equal(delivery.toISOString(), "2026-07-29T14:00:00.000Z");
    assert.equal(guest.toISOString(), "2026-07-30T10:00:00.000Z");
  });

  it("visitorTypeLabel covers cab", () => {
    assert.equal(visitorTypeLabel("CAB"), "Cab");
    assert.equal(visitorTypeLabel("GUEST"), "Guest");
  });

  it("expectedCheckoutAtForVisitorType uses overstay minutes", () => {
    assert.equal(VISITOR_TYPE_OVERSTAY_MINUTES.DELIVERY, 45);
    const checkIn = new Date("2026-07-29T10:00:00.000Z");
    const checkout = expectedCheckoutAtForVisitorType("DELIVERY", checkIn);
    assert.equal(checkout.toISOString(), "2026-07-29T10:45:00.000Z");
  });
});
