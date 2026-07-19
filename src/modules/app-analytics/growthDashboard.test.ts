import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANALYTICS_DATA_SOURCES,
  BUSINESS_ACTION_CATALOG,
  BUSINESS_ACTION_LABELS,
  FIREBASE_MIRRORED_EVENTS,
} from "./analyticsCatalog.js";

describe("growthDashboard catalog", () => {
  it("maps business actions to Firebase mirror events", () => {
    assert.ok(BUSINESS_ACTION_CATALOG.length >= 8);
    assert.equal(BUSINESS_ACTION_CATALOG[0]?.firebaseEvent, "business_action");
    assert.ok(FIREBASE_MIRRORED_EVENTS.some((e) => e.customKind === "ACTION"));
    assert.equal(BUSINESS_ACTION_LABELS.resident_maintenance_payment, "Maintenance payment");
  });

  it("documents dual data sources for admin dashboards", () => {
    assert.equal(ANALYTICS_DATA_SOURCES.primary.id, "custom_backend");
    assert.equal(ANALYTICS_DATA_SOURCES.mirror.id, "firebase_analytics");
    assert.ok(ANALYTICS_DATA_SOURCES.primary.description.includes("database"));
    assert.ok(ANALYTICS_DATA_SOURCES.mirror.description.includes("GA4"));
  });
});
