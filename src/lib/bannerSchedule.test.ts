import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bannerEndDateIsActive,
  bannerEndDateStillActiveWhere,
  bannerStartDateIsActive,
  endOfUtcDay,
  normalizeBannerEndDate,
  normalizeBannerStartDate,
} from "./bannerSchedule";

describe("bannerSchedule", () => {
  it("normalizeBannerEndDate extends midnight to end of IST calendar day", () => {
    const raw = new Date("2026-07-31T00:00:00.000Z");
    assert.equal(normalizeBannerEndDate(raw).toISOString(), "2026-07-31T18:29:59.999Z");
  });

  it("bannerEndDateIsActive treats legacy midnight end as full calendar day", () => {
    const endDate = new Date("2026-07-31T00:00:00.000Z");
    const midday = new Date("2026-07-31T12:00:00.000Z");
    const nextDay = new Date("2026-08-01T00:00:01.000Z");
    assert.equal(bannerEndDateIsActive(endDate, midday), true);
    assert.equal(bannerEndDateIsActive(endDate, nextDay), false);
  });

  it("active window covers Jul 30–31 inclusive on Jul 31 midday IST", () => {
    const startDate = normalizeBannerStartDate(new Date("2026-07-30T00:00:00.000Z"));
    const endDate = new Date("2026-07-31T00:00:00.000Z");
    const middayJul31 = new Date("2026-07-31T12:00:00.000Z");
    assert.equal(bannerStartDateIsActive(startDate, middayJul31), true);
    assert.equal(bannerEndDateIsActive(endDate, middayJul31), true);
  });

  it("bannerEndDateStillActiveWhere matches legacy midnight end on same IST day", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const where = bannerEndDateStillActiveWhere(now);
    const legacyEnd = new Date("2026-07-31T00:00:00.000Z");
    const or = where.OR ?? [];
    const gteNow = (or[1] as { endDate?: { gte: Date } }).endDate?.gte;
    const legacyBranch = or[2] as { AND?: { endDate: { gte?: Date; lte?: Date } }[] };
    const legacyGte = legacyBranch.AND?.[0]?.endDate?.gte;
    const legacyLte = legacyBranch.AND?.[1]?.endDate?.lte;
    assert.ok(gteNow);
    assert.ok(legacyGte);
    assert.ok(legacyLte);
    assert.equal(legacyEnd >= gteNow, false);
    assert.equal(legacyEnd >= legacyGte && legacyEnd <= legacyLte, true);
    assert.equal(endOfUtcDay(legacyEnd).toISOString(), "2026-07-31T18:29:59.999Z");
  });
});
