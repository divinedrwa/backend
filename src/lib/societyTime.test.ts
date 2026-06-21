import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  localDateKey,
  startOfLocalDayDaysAgo,
  startOfLocalMonth,
} from "./societyTime.js";

describe("societyTime zone handling", () => {
  it("computes Asia/Kolkata local midnight at +5:30 (UTC 18:30 the prior day)", () => {
    // Local midnight 2026-03-15 in Kolkata == 2026-03-14T18:30:00Z.
    const start = startOfLocalMonth("2026-03", "Asia/Kolkata");
    // March 1 local midnight == Feb 28 18:30Z.
    assert.equal(start.toISOString(), "2026-02-28T18:30:00.000Z");
    // Round-trips: formatting that instant in Kolkata yields the 1st.
    assert.equal(localDateKey(start, "Asia/Kolkata"), "2026-03-01");
  });

  it("derives the offset from Intl for a non-Kolkata zone (no silent UTC fallback)", () => {
    // America/New_York standard time is UTC-5 (Jan, no DST).
    const start = startOfLocalMonth("2026-01", "America/New_York");
    // Jan 1 00:00 local == Jan 1 05:00Z.
    assert.equal(start.toISOString(), "2026-01-01T05:00:00.000Z");
    assert.equal(localDateKey(start, "America/New_York"), "2026-01-01");
  });

  it("startOfLocalDayDaysAgo lands on local midnight for an arbitrary zone", () => {
    const start = startOfLocalDayDaysAgo(0, "America/New_York");
    // The instant, rendered back in the zone, is the start of today (a valid date).
    assert.match(localDateKey(start, "America/New_York"), /^\d{4}-\d{2}-\d{2}$/);
    // Local hour at that instant must be 0 (midnight).
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(start);
    assert.equal(parseInt(hour, 10) % 24, 0);
  });
});
