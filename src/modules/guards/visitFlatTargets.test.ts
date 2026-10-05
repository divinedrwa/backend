import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveVisitorApprovalRecipientIds } from "./visitor-state-manager";
import { occupiedFloorsOfVilla } from "./visitFlatTargets";

type Occupant = { id: string; unitId: string | null; villaId?: string };

/** Minimal in-memory stand-in for the two User queries these functions run. */
function fakeDb(users: Occupant[]) {
  return {
    user: {
      findMany: async (args: { where: { villaId?: string | { in: string[] }; unitId?: string; id?: string } }) => {
        const w = args.where;
        return users.filter((u) => {
          const villaOk =
            w.villaId === undefined ||
            (typeof w.villaId === "string" ? (u.villaId ?? "v1") === w.villaId : w.villaId.in.includes(u.villaId ?? "v1"));
          return villaOk && (w.unitId === undefined || u.unitId === w.unitId);
        });
      },
      findFirst: async (args: { where: { id?: string } }) => users.find((u) => u.id === args.where.id) ?? null,
    },
    // Family members who can approve on a resident's behalf: none in these cases.
    familyMember: { findMany: async () => [] },
  };
}

describe("occupiedFloorsOfVilla", () => {
  it("lists every floor that has a resident (owner and tenant on different floors)", async () => {
    const db = fakeDb([
      { id: "tenant-gf", unitId: "gf" },
      { id: "owner-ff", unitId: "ff" },
    ]);
    const r = await occupiedFloorsOfVilla(db as never, { societyId: "s", villaId: "v1" });
    assert.deepEqual(r.unitIds.sort(), ["ff", "gf"]);
    assert.deepEqual(r.unplacedResidentIds, []);
  });

  it("counts a floor once however many people live on it", async () => {
    const db = fakeDb([
      { id: "a", unitId: "gf" },
      { id: "b", unitId: "gf" },
      { id: "c", unitId: "ff" },
    ]);
    const r = await occupiedFloorsOfVilla(db as never, { societyId: "s", villaId: "v1" });
    assert.deepEqual(r.unitIds.sort(), ["ff", "gf"]);
  });

  it("returns residents with no floor separately so they are still asked", async () => {
    const db = fakeDb([
      { id: "owner", unitId: "gf" },
      { id: "no-floor", unitId: null },
    ]);
    const r = await occupiedFloorsOfVilla(db as never, { societyId: "s", villaId: "v1" });
    assert.deepEqual(r.unitIds, ["gf"]);
    assert.deepEqual(r.unplacedResidentIds, ["no-floor"]);
  });

  it("returns nothing for an empty flat", async () => {
    const r = await occupiedFloorsOfVilla(fakeDb([]) as never, { societyId: "s", villaId: "v1" });
    assert.deepEqual(r, { unitIds: [], unplacedResidentIds: [] });
  });
});

describe("approval recipients for per-floor targets", () => {
  it("asks both floors when both are targeted, plus a resident with no floor", async () => {
    const db = fakeDb([
      { id: "tenant-gf", unitId: "gf" },
      { id: "owner-ff", unitId: "ff" },
      { id: "no-floor", unitId: null },
    ]);
    const ids = await resolveVisitorApprovalRecipientIds({
      prisma: db as never,
      societyId: "s",
      villaIds: ["v1"],
      targets: [
        { villaId: "v1", unitId: "gf" },
        { villaId: "v1", unitId: "ff" },
        { villaId: "v1", residentUserId: "no-floor" },
      ],
    });
    assert.deepEqual(ids.sort(), ["no-floor", "owner-ff", "tenant-gf"]);
  });

  it("asks only the chosen floor when the guard picks one floor", async () => {
    const db = fakeDb([
      { id: "tenant-gf", unitId: "gf" },
      { id: "owner-ff", unitId: "ff" },
    ]);
    const ids = await resolveVisitorApprovalRecipientIds({
      prisma: db as never,
      societyId: "s",
      villaIds: ["v1"],
      targets: [{ villaId: "v1", unitId: "ff" }],
    });
    assert.deepEqual(ids, ["owner-ff"]);
  });
});
