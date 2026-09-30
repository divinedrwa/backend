import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { longestGapMinutes, supplyIntervals, supplyMinutesByDay } from "./supplyIntervals";

const at = (iso: string) => new Date(iso);
const on = (iso: string) => ({ createdAt: at(iso), action: "ON", turnedOn: true });
const off = (iso: string) => ({ createdAt: at(iso), action: "OFF", turnedOn: false });

describe("supplyIntervals", () => {
  const from = at("2026-09-24T18:30:00Z"); // 25 Sep 00:00 IST
  const to = at("2026-09-26T18:30:00Z"); // 27 Sep 00:00 IST

  it("pairs ON→OFF and counts supply already running when the period starts", () => {
    const ivs = supplyIntervals(
      [off("2026-09-24T19:30:00Z"), on("2026-09-25T02:00:00Z"), off("2026-09-25T03:00:00Z")],
      from,
      to,
      on("2026-09-24T17:00:00Z"),
    );
    assert.equal(ivs.length, 2);
    assert.equal((ivs[0]!.end.getTime() - ivs[0]!.start.getTime()) / 60000, 60); // from start → first OFF
    assert.equal((ivs[1]!.end.getTime() - ivs[1]!.start.getTime()) / 60000, 60);
  });

  it("ignores repeated ON taps and caps a forgotten OFF", () => {
    const ivs = supplyIntervals([on("2026-09-25T02:00:00Z"), on("2026-09-25T02:10:00Z")], from, to, null);
    assert.equal(ivs.length, 1);
    assert.equal(ivs[0]!.ongoing, true);
    assert.equal((ivs[0]!.end.getTime() - ivs[0]!.start.getTime()) / 3_600_000, 12);
  });

  it("splits supply across local midnight and finds the longest gap", () => {
    // 25 Sep 23:00 → 26 Sep 01:00 IST.
    const ivs = supplyIntervals([on("2026-09-25T17:30:00Z"), off("2026-09-25T19:30:00Z")], from, to, null);
    const byDay = supplyMinutesByDay(ivs);
    assert.equal(Math.round(byDay.get("2026-09-25")!), 60);
    assert.equal(Math.round(byDay.get("2026-09-26")!), 60);
    // Gaps: 25 Sep 00:00→23:00 (23h) and 26 Sep 01:00→27 Sep 00:00 (23h).
    assert.equal(longestGapMinutes(ivs, from, to), 23 * 60);
  });
});
