import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackingWindow } from "./loadSupply.js";

const d = (iso: string) => new Date(iso);

describe("trackingWindow", () => {
  const from = d("2026-09-01T00:00:00Z");
  const to = d("2026-09-30T12:00:00Z");

  it("starts after the last logging break, not at the period start", () => {
    const w = trackingWindow(
      [d("2026-08-02T14:00:00Z"), d("2026-09-27T12:00:00Z"), d("2026-09-29T04:00:00Z"), d("2026-09-30T03:00:00Z")],
      from,
      to,
    );
    assert.equal(w.trackedFrom.toISOString(), "2026-09-27T12:00:00.000Z");
    assert.equal(w.tracked, true);
    assert.equal(w.stale, false);
  });

  it("uses the period start when guards logged steadily", () => {
    const w = trackingWindow([d("2026-08-30T00:00:00Z"), d("2026-09-01T10:00:00Z"), d("2026-09-02T10:00:00Z")], from, d("2026-09-03T00:00:00Z"));
    assert.equal(w.trackedFrom.toISOString(), from.toISOString());
  });

  it("flags logging that stopped more than 3 days ago", () => {
    const w = trackingWindow([d("2026-09-10T10:00:00Z"), d("2026-09-11T10:00:00Z")], from, to);
    assert.equal(w.stale, true);
    assert.equal(w.lastLoggedAt?.toISOString(), "2026-09-11T10:00:00.000Z");
  });

  it("is not tracked without any taps in the period", () => {
    assert.equal(trackingWindow([], from, to).tracked, false);
    assert.equal(trackingWindow([d("2026-07-01T00:00:00Z")], from, to).tracked, false);
  });
});
