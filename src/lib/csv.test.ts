import test from "node:test";
import assert from "node:assert/strict";
import { getCsvFieldLoose, csvRowsToRecords, parseCsvRows } from "./csv";

test("getCsvFieldLoose matches header variants", () => {
  assert.equal(getCsvFieldLoose({ defaultFloor: "2" }, "defaultFloor"), "2");
  assert.equal(getCsvFieldLoose({ "Default Floor": "1" }, "defaultFloor"), "1");
  assert.equal(getCsvFieldLoose({ default_floor: "0" }, "defaultFloor"), "0");
  assert.equal(getCsvFieldLoose({ villaNumber: "V1" }, "defaultFloor"), "");
});

test("getCsvFieldLoose reads from parseCsvRows + csvRowsToRecords", () => {
  const rows = parseCsvRows("villaNumber,Default Floor\nX-1,3\n");
  const rec = csvRowsToRecords(rows[0]!, rows.slice(1))[0]!;
  assert.equal(getCsvFieldLoose(rec, "defaultFloor"), "3");
});
