/** Shared catalog: custom backend events mirrored to Firebase from the mobile app. */

export type GrowthPillar =
  | "acquisition"
  | "engagement"
  | "operations"
  | "monetization"
  | "communication";

export type CatalogEntry = {
  id: string;
  label: string;
  pillar: GrowthPillar;
  firebaseEvent: string;
  description: string;
};

export const ANALYTICS_DATA_SOURCES = {
  primary: {
    id: "custom_backend",
    label: "Society analytics (server)",
    description:
      "User-attributed events stored in your database — powers admin dashboards, engagement, and adoption.",
  },
  mirror: {
    id: "firebase_analytics",
    label: "Firebase Analytics (mirror)",
    description:
      "Same sessions, screens, flows, and business actions are dual-written from the app for GA4 funnels and BigQuery export.",
  },
} as const;

export const BUSINESS_ACTION_CATALOG: CatalogEntry[] = [
  {
    id: "resident_pre_approve_visitor",
    label: "Pre-approve visitor",
    pillar: "communication",
    firebaseEvent: "business_action",
    description: "Resident pre-approved a visitor — gate workflow driver.",
  },
  {
    id: "resident_complaint_submit",
    label: "Submit complaint",
    pillar: "communication",
    firebaseEvent: "business_action",
    description: "Resident filed a complaint — community engagement signal.",
  },
  {
    id: "resident_maintenance_payment",
    label: "Maintenance payment",
    pillar: "monetization",
    firebaseEvent: "business_action",
    description: "Resident completed an online maintenance payment.",
  },
  {
    id: "resident_amenity_booking",
    label: "Amenity booking",
    pillar: "engagement",
    firebaseEvent: "business_action",
    description: "Resident booked a society amenity.",
  },
  {
    id: "resident_poll_vote",
    label: "Poll vote",
    pillar: "engagement",
    firebaseEvent: "business_action",
    description: "Resident participated in a community poll.",
  },
  {
    id: "admin_notice_publish",
    label: "Publish notice",
    pillar: "communication",
    firebaseEvent: "business_action",
    description: "Admin published a notice to residents.",
  },
  {
    id: "admin_billing_cycle_publish",
    label: "Publish billing cycle",
    pillar: "monetization",
    firebaseEvent: "business_action",
    description: "Admin published a billing cycle — unlocks resident payments.",
  },
  {
    id: "admin_expense_add",
    label: "Add expense",
    pillar: "operations",
    firebaseEvent: "business_action",
    description: "Admin recorded a society expense.",
  },
  {
    id: "guard_qr_scan",
    label: "Guard QR scan",
    pillar: "operations",
    firebaseEvent: "business_action",
    description: "Guard scanned a visitor QR at the gate.",
  },
];

export const BUSINESS_ACTION_LABELS: Record<string, string> = Object.fromEntries(
  BUSINESS_ACTION_CATALOG.map((e) => [e.id, e.label]),
);

export const FIREBASE_FREE_TIER_METRICS = [
  {
    id: "dau_wau_mau",
    label: "Active users (DAU / WAU / MAU)",
    source: "automatic",
    firebaseEvent: "user_engagement",
    consolePath: "Analytics → Dashboard",
    description: "Daily, weekly, and monthly active users with trend charts.",
  },
  {
    id: "retention_cohorts",
    label: "Retention & cohorts",
    source: "automatic",
    firebaseEvent: "first_open",
    consolePath: "Analytics → Retention",
    description: "Week-over-week return rates and cohort heatmaps.",
  },
  {
    id: "geography",
    label: "Users by country",
    source: "automatic",
    firebaseEvent: "user_engagement",
    consolePath: "Analytics → Dashboard → Country",
    description: "Geographic distribution from device IP (no extra code).",
  },
  {
    id: "device_models",
    label: "Device models",
    source: "automatic",
    firebaseEvent: "user_engagement",
    consolePath: "Analytics → Dashboard → Device model",
    description: "Hardware breakdown (e.g. Pixel, Samsung) for compatibility planning.",
  },
  {
    id: "app_versions",
    label: "App version adoption",
    source: "automatic",
    firebaseEvent: "user_engagement",
    consolePath: "Analytics → Latest app release",
    description: "Which app versions are in the field — drives upgrade campaigns.",
  },
  {
    id: "engagement_time",
    label: "Engagement time & sessions",
    source: "automatic",
    firebaseEvent: "user_engagement",
    consolePath: "Analytics → Engagement",
    description: "Average engagement time per user and engaged sessions per user.",
  },
  {
    id: "screen_views",
    label: "Screen views",
    source: "custom_mirror",
    firebaseEvent: "screen_view",
    consolePath: "Analytics → Events → screen_view",
    description: "Named screens (e.g. Pre-approve visitor) — dual-written from the app.",
  },
  {
    id: "notifications",
    label: "Push notifications",
    source: "custom_mirror",
    firebaseEvent: "notification_receive",
    consolePath: "Analytics → Events",
    description: "Receive and open events for visitor alerts, notices, and approvals.",
  },
  {
    id: "business_actions",
    label: "Business actions",
    source: "custom_mirror",
    firebaseEvent: "business_action",
    consolePath: "Analytics → Events → business_action",
    description: "Payments, pre-approvals, complaints, guard QR scans — filter by action param.",
  },
  {
    id: "crash_free",
    label: "Crash-free users",
    source: "crashlytics",
    firebaseEvent: "app_exception",
    consolePath: "Crashlytics → Dashboard",
    description: "Stability percentage — free on Spark plan alongside Analytics.",
  },
  {
    id: "realtime",
    label: "Realtime active users",
    source: "automatic",
    firebaseEvent: "user_engagement",
    consolePath: "Analytics → Realtime",
    description: "Live count and top countries for the last 30 minutes.",
  },
] as const;

export const FIREBASE_MIRRORED_EVENTS = [
  { customKind: "SESSION_START", firebaseEvent: "session_start" },
  { customKind: "SESSION_END", firebaseEvent: "session_end" },
  { customKind: "LOGIN", firebaseEvent: "login" },
  { customKind: "LOGOUT", firebaseEvent: "logout" },
  { customKind: "SCREEN_VIEW", firebaseEvent: "screen_view" },
  { customKind: "FLOW_COMPLETE", firebaseEvent: "guard_flow_complete" },
  { customKind: "ACTION", firebaseEvent: "business_action" },
  { customKind: "ERROR", firebaseEvent: "app_error" },
] as const;
