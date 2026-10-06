/**
 * A push with no readable text must never reach a phone (the app would show a placeholder "Notification" / "Notification").
 * Runs the real NotificationService.sendToTokens with Firebase replaced by a recorder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import admin from "firebase-admin";
import { NotificationService } from "./notification.service";
import { APP_NAME } from "../lib/branding";

type Sent = { notification?: { title?: string; body?: string }; data?: Record<string, string>; tokens?: string[]; topic?: string };
const sent: Sent[] = [];
// admin.messaging() resolves the default app's messaging(): give that app a recorder (no network, no credentials)
const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "push-test" });
(app as unknown as { messaging: () => unknown }).messaging = () => ({
  sendEachForMulticast: async (m: Sent) => { sent.push(m); return { successCount: (m.tokens ?? []).length, failureCount: 0, responses: [] }; },
  send: async (m: Sent) => { sent.push(m); return "projects/test/messages/1"; },
});
const ZERO_WIDTH = String.fromCharCode(0x200b);

test("a normal push is sent as written, with the same text in the data block", async () => {
  sent.length = 0;
  await NotificationService.sendToTokens(["tok1"], { title: "Visitor admitted", body: "Ravi was approved.", data: { type: "VISITOR_APPROVAL_RESOLVED" } });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].notification, { title: "Visitor admitted", body: "Ravi was approved." });
  assert.equal(sent[0].data?.title, "Visitor admitted");
  assert.equal(sent[0].data?.body, "Ravi was approved.");
  assert.equal(sent[0].data?.type, "VISITOR_APPROVAL_RESOLVED");
});

test("a push with no title and no body is not sent at all", async () => {
  sent.length = 0;
  for (const blank of ["", "   ", ZERO_WIDTH]) {
    await NotificationService.sendToTokens(["tok1"], { title: blank, body: blank, data: { type: "SOMETHING" } });
  }
  await NotificationService.sendToTokens(["tok1"], { title: undefined as unknown as string, body: undefined as unknown as string });
  assert.equal(sent.length, 0);
});

test("a push with only one of title / body is filled in, never sent empty", async () => {
  sent.length = 0;
  await NotificationService.sendToTokens(["tok1"], { title: "", body: "Your water request was fulfilled." });
  await NotificationService.sendToTokens(["tok2"], { title: "Parcel at gate", body: "" });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].notification, { title: APP_NAME, body: "Your water request was fulfilled." });
  assert.deepEqual(sent[1].notification, { title: "Parcel at gate", body: "Parcel at gate" });
  for (const m of sent) { assert.ok(m.data?.title && m.data?.body, "the data block carries the text too"); }
});

test("topics follow the same rule", async () => {
  sent.length = 0;
  await NotificationService.sendToTopic("society-1", { title: " ", body: "" });
  assert.equal(sent.length, 0);
  await NotificationService.sendToTopic("society-1", { title: "Notice", body: "Water cut tomorrow." });
  assert.equal(sent.length, 1);
});
