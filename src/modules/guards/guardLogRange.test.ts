import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNowWithinShift, resolveGuardLogRange } from "./guardLogRange";

describe("resolveGuardLogRange", () => {
  it("returns today window when from/to absent", () => {
    const r = resolveGuardLogRange({});
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.endInclusive.getTime() >= r.start.getTime());
  });

  it("rejects partial from/to", () => {
    const r = resolveGuardLogRange({ from: "2026-04-01" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /Both from and to/);
  });

  it("parses inclusive range", () => {
    const r = resolveGuardLogRange({
      from: "2026-04-01",
      to: "2026-04-03",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.start.getFullYear(), 2026);
    assert.equal(r.start.getMonth(), 3);
    assert.equal(r.start.getDate(), 1);
    assert.equal(r.endInclusive.getDate(), 3);
  });

  it("rejects from after to", () => {
    const r = resolveGuardLogRange({
      from: "2026-04-10",
      to: "2026-04-01",
    });
    assert.equal(r.ok, false);
  });
});

describe("isNowWithinShift", () => {
  it("true when now inside window", () => {
    const start = new Date("2026-04-01T08:00:00.000Z");
    const end = new Date("2026-04-01T16:00:00.000Z");
    const now = new Date("2026-04-01T12:00:00.000Z");
    assert.equal(isNowWithinShift(start, end, now), true);
  });

  it("false when before start", () => {
    const start = new Date("2026-04-01T08:00:00.000Z");
    const end = new Date("2026-04-01T16:00:00.000Z");
    const now = new Date("2026-04-01T07:00:00.000Z");
    assert.equal(isNowWithinShift(start, end, now), false);
  });
});
