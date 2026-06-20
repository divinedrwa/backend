import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findResidentVisitorVillaRow,
  residentVisitorVillaVisitWhere,
} from "./residentVisitorApprovalScope.js";

describe("residentVisitorVillaVisitWhere", () => {
  it("matches unit or residentUserId when resident has unitId", () => {
    const where = residentVisitorVillaVisitWhere({
      villaId: "villa1",
      userId: "user1",
      unitId: "unitB",
    });
    assert.deepEqual(where, {
      villaId: "villa1",
      OR: [{ unitId: "unitB" }, { residentUserId: "user1" }],
    });
  });

  it("matches villa only when resident has no unitId", () => {
    const where = residentVisitorVillaVisitWhere({
      villaId: "villa1",
      userId: "user1",
      unitId: null,
    });
    assert.deepEqual(where, { villaId: "villa1" });
  });
});

describe("findResidentVisitorVillaRow", () => {
  it("falls back to residentUserId when unitId does not match", async () => {
    const row = {
      id: "vv1",
      unitId: "unitA",
      residentUserId: "resident1",
      visitor: { societyId: "soc1" },
      villa: { villaNumber: "101", block: "A" },
    };
    const db = {
      visitorVilla: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          if ("unitId" in args.where && args.where.unitId === "unitB") return null;
          if (args.where.residentUserId === "resident1") return row;
          return null;
        },
      },
    };

    const found = await findResidentVisitorVillaRow(db as never, {
      visitorId: "vis1",
      societyId: "soc1",
      userId: "resident1",
      villaId: "villa1",
      unitId: "unitB",
    });

    assert.equal(found?.id, "vv1");
  });
});
