import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GUARD_VILLA_LIST_CAP, resolveVillaListPagination } from "./listPagination";

const normal = { take: 50, skip: 0, limit: 50, offset: 0 };

describe("resolveVillaListPagination", () => {
  it("gives a guard every flat when no paging is requested (the app sends none)", () => {
    const p = resolveVillaListPagination("GUARD", {}, normal);
    assert.equal(p.take, GUARD_VILLA_LIST_CAP);
    assert.ok(p.take > 200, "must exceed the normal 200 cap");
    assert.equal(p.skip, 0);
  });

  it("respects a page a guard explicitly asks for", () => {
    const asked = { take: 20, skip: 40, limit: 20, offset: 40 };
    assert.deepEqual(resolveVillaListPagination("GUARD", { limit: "20", offset: "40" }, asked), asked);
    assert.deepEqual(resolveVillaListPagination("GUARD", { limit: "20" }, asked), asked);
  });

  it("leaves everyone else on the normal paging", () => {
    for (const role of ["ADMIN", "RESIDENT", "RESIDENT_CUM_ADMIN", undefined]) {
      assert.deepEqual(resolveVillaListPagination(role, {}, normal), normal);
    }
  });
});
