import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VisitorStatus } from "@prisma/client";
import {
  summarizeVisitorsToday,
  visitorCheckInDate,
  visitorIsCheckedOut,
  visitorIsInside,
} from "./visitorLifecycle.js";

describe("visitorLifecycle", () => {
  it("treats checkOutAt as checked out when checkOutTime is null", () => {
    assert.equal(
      visitorIsCheckedOut({
        checkOutTime: null,
        checkOutAt: new Date("2026-07-30T06:35:00.000Z"),
        status: VisitorStatus.CHECKED_IN,
      }),
      true,
    );
  });

  it("uses CHECKED_OUT status when timestamps are missing", () => {
    assert.equal(
      visitorIsCheckedOut({
        checkOutTime: null,
        checkOutAt: null,
        status: VisitorStatus.CHECKED_OUT,
      }),
      true,
    );
  });

  it("resolves check-in and check-out aliases", () => {
    const checkIn = new Date("2026-07-30T05:00:00.000Z");
    const checkOut = new Date("2026-07-30T06:35:00.000Z");
    assert.deepEqual(
      visitorCheckInDate({ checkInAt: checkIn, checkInTime: null }),
      checkIn,
    );
    assert.equal(
      visitorIsInside({
        status: VisitorStatus.CHECKED_IN,
        checkOutTime: null,
        checkOutAt: null,
      }),
      true,
    );
    assert.equal(
      visitorIsInside({
        status: VisitorStatus.PENDING_APPROVAL,
        checkOutTime: null,
        checkOutAt: null,
      }),
      false,
    );
    assert.deepEqual(
      summarizeVisitorsToday(
        [
          {
            status: VisitorStatus.CHECKED_IN,
            checkInTime: checkIn,
            checkOutTime: null,
            checkOutAt: null,
          },
          {
            status: VisitorStatus.CHECKED_OUT,
            checkInTime: checkIn,
            checkOutTime: null,
            checkOutAt: checkOut,
          },
        ],
        new Date("2026-07-30T12:00:00.000Z"),
      ),
      { total: 2, checkedIn: 1, checkedOut: 1 },
    );
  });
});
