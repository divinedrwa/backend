import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPushText, preparePushText } from "./pushText";
import { APP_NAME } from "./branding";

const ZERO_WIDTH = String.fromCharCode(0x200b);
const NBSP = String.fromCharCode(0x00a0);
const BOM = String.fromCharCode(0xfeff);

test("ordinary text is kept, with extra spaces tidied", () => {
  assert.equal(cleanPushText("  Visitor   admitted "), "Visitor admitted");
  assert.deepEqual(preparePushText({ title: "Visitor admitted", body: "Ravi's entry was approved." }), { title: "Visitor admitted", body: "Ravi's entry was approved." });
});

test("nothing visible means nothing to send: empty, spaces, no-break space, zero-width and BOM characters, non-strings", () => {
  for (const blank of ["", "   ", "\n\t", NBSP, ZERO_WIDTH, `${BOM}${ZERO_WIDTH} ${NBSP}`, undefined, null, 0, {}]) {
    assert.equal(cleanPushText(blank), "", `blank: ${JSON.stringify(blank)}`);
  }
  assert.equal(preparePushText({ title: "", body: "" }), null);
  assert.equal(preparePushText({ title: ZERO_WIDTH, body: NBSP }), null);
  assert.equal(preparePushText({}), null);
  assert.equal(preparePushText({ title: undefined, body: null }), null);
});

test("a missing title becomes the app name; a missing body repeats the title", () => {
  assert.deepEqual(preparePushText({ title: "", body: "Your parcel is at the gate." }), { title: APP_NAME, body: "Your parcel is at the gate." });
  assert.deepEqual(preparePushText({ title: "Parcel at gate", body: ZERO_WIDTH }), { title: "Parcel at gate", body: "Parcel at gate" });
});

test("invisible characters inside real text are removed, real text is untouched (including non-English)", () => {
  assert.equal(cleanPushText(`Gate${ZERO_WIDTH} pass`), "Gate pass");
  assert.equal(cleanPushText("आगंतुक को अनुमति मिली"), "आगंतुक को अनुमति मिली");
  assert.equal(cleanPushText("Rs. 1,200 due ✅"), "Rs. 1,200 due ✅");
});
