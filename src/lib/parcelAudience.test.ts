import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flatLabelOf, parcelRecipientWhere, parcelVisibleToResidentWhere, withFlatLabels } from "./parcelAudience";

type Where = { OR?: Array<{ unitId: string | null }>; unitId?: string | null };
/** Evaluates only the floor condition of a where-clause against a row, the part these rules are about. */
const floorMatches = (where: Where, unitId: string | null): boolean =>
  where.OR ? where.OR.some((c) => c.unitId === unitId) : where.unitId === undefined || where.unitId === unitId;

// A-12: tenant on the ground floor, owner on the first floor, and a resident with no floor set.
const people = [
  { name: "tenant (GF)", unitId: "gf" },
  { name: "owner (FF)", unitId: "ff" },
  { name: "no floor", unitId: null },
];

describe("parcelRecipientWhere (who is notified)", () => {
  it("a parcel for the first floor reaches the first floor and residents with no floor, not the ground floor", () => {
    const where = parcelRecipientWhere({ societyId: "s", villaId: "v12", unitId: "ff" }) as Where;
    assert.deepEqual(people.filter((p) => floorMatches(where, p.unitId)).map((p) => p.name), ["owner (FF)", "no floor"]);
  });

  it("a parcel for the ground floor reaches the tenant, not the owner upstairs", () => {
    const where = parcelRecipientWhere({ societyId: "s", villaId: "v12", unitId: "gf" }) as Where;
    assert.deepEqual(people.filter((p) => floorMatches(where, p.unitId)).map((p) => p.name), ["tenant (GF)", "no floor"]);
  });

  it("a parcel with no floor reaches every resident of the flat, as before", () => {
    const where = parcelRecipientWhere({ societyId: "s", villaId: "v12" }) as Where;
    assert.equal(where.OR, undefined);
    assert.equal(people.filter((p) => floorMatches(where, p.unitId)).length, 3);
  });

  it("is always limited to active residents of that flat and society", () => {
    const where = parcelRecipientWhere({ societyId: "s1", villaId: "v1", unitId: "ff" }) as Record<string, unknown>;
    assert.equal(where.societyId, "s1");
    assert.equal(where.villaId, "v1");
    assert.equal(where.isActive, true);
    assert.ok(where.role, "restricted to resident-like roles");
  });
});

describe("parcelVisibleToResidentWhere (who sees the parcel)", () => {
  const parcels = [
    { name: "for ground floor", unitId: "gf" },
    { name: "for first floor", unitId: "ff" },
    { name: "for the whole flat", unitId: null },
  ];
  const visible = (residentUnit: string | null) =>
    parcels.filter((p) => floorMatches(parcelVisibleToResidentWhere(residentUnit) as Where, p.unitId)).map((p) => p.name);

  it("the tenant on the ground floor sees ground-floor and whole-flat parcels, not the owner's", () => {
    assert.deepEqual(visible("gf"), ["for ground floor", "for the whole flat"]);
  });

  it("the owner on the first floor sees first-floor and whole-flat parcels", () => {
    assert.deepEqual(visible("ff"), ["for first floor", "for the whole flat"]);
  });

  it("a resident with no floor set still sees every parcel of the flat", () => {
    assert.deepEqual(parcelVisibleToResidentWhere(null), {});
    assert.deepEqual(parcelVisibleToResidentWhere(undefined), {});
  });
});

describe("flat labels", () => {
  it("block and number, or just the number", () => {
    assert.equal(flatLabelOf({ block: "A", villaNumber: "12" }), "A-12");
    assert.equal(flatLabelOf({ block: " ", villaNumber: "12" }), "12");
    assert.equal(flatLabelOf({ villaNumber: "07" }), "07");
  });

  it("adds the flat and floor labels to a parcel for the guard's list", () => {
    const p = withFlatLabels({ id: "p1", villa: { block: "A", villaNumber: "12" }, unit: { label: "Ground floor" } });
    assert.equal(p.flatLabel, "A-12");
    assert.equal(p.unitLabel, "Ground floor");
    assert.equal(p.id, "p1");
    const whole = withFlatLabels({ villa: { block: null, villaNumber: "3" }, unit: null });
    assert.equal(whole.flatLabel, "3");
    assert.equal(whole.unitLabel, null);
  });
});
