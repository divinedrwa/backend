import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePath, resolveBody, resolveQuery } from "./http.js";
import type { SmokeContext } from "./types.js";

const ctx: SmokeContext = {
  baseUrl: "http://127.0.0.1:4000",
  societyId: "soc-1",
  tokens: {},
  ids: { villaId: "villa-9", visitorId: "vis-1" },
};

describe("mobile-api http helpers", () => {
  it("resolvePath substitutes societyId and ids", () => {
    const r = resolvePath("/residents/special-projects/:specialProjectId", ctx);
    assert.equal(r.missing.length, 1);
    assert.match(r.path, /__missing_specialProjectId__/);
  });

  it("resolvePath fills known ids", () => {
    const r = resolvePath("/guards/parcels/:parcelId/delivered", {
      ...ctx,
      ids: { ...ctx.ids, parcelId: "p-1" },
    });
    assert.deepEqual(r.missing, []);
    assert.equal(r.path, "/guards/parcels/p-1/delivered");
  });

  it("resolveQuery maps societyId placeholder", () => {
    const r = resolveQuery({ societyId: ":societyId" }, ctx);
    assert.deepEqual(r.missing, []);
    assert.equal(r.query?.societyId, "soc-1");
  });

  it("resolveBody maps villaId placeholder", () => {
    const r = resolveBody({ villaId: ":villaId", note: "x" }, ctx);
    assert.deepEqual(r.missing, []);
    assert.equal(r.body?.villaId, "villa-9");
    assert.equal(r.body?.note, "x");
  });
});
