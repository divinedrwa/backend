export type MobileApiRole = "public" | "resident" | "guard" | "admin";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type MobileApiCase = {
  /** Human label shown in reports */
  name: string;
  method: HttpMethod;
  /** Path under `/api` (e.g. `/residents/dashboard`) */
  path: string;
  roles: MobileApiRole[];
  /** Acceptable HTTP status codes (500 always fails) */
  expect: number[];
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  /** When true, case is skipped if resolver could not fill `:id` placeholders */
  optional?: boolean;
};

export type SmokeTokens = {
  resident?: string;
  guard?: string;
  admin?: string;
};

export type SmokeIds = {
  villaId?: string;
  parcelId?: string;
  pollId?: string;
  pollOptionId?: string;
  complaintId?: string;
  visitorId?: string;
  preApprovedId?: string;
  amenityId?: string;
  bookingId?: string;
  staffAssignmentId?: string;
  vehicleId?: string;
  familyMemberId?: string;
  emergencyContactId?: string;
  expenseId?: string;
  noticeId?: string;
  pollAdminId?: string;
  guardShiftId?: string;
  incidentId?: string;
  vehicleEntryId?: string;
  billingCycleId?: string;
  financialYearId?: string;
  specialProjectId?: string;
  contributionId?: string;
  bankAccountId?: string;
  gateId?: string;
  garbageEventId?: string;
  sosAlertId?: string;
};

export type SmokeContext = {
  baseUrl: string;
  societyId: string;
  tokens: SmokeTokens;
  ids: SmokeIds;
};

export type SmokeResult = {
  name: string;
  role: MobileApiRole;
  method: HttpMethod;
  path: string;
  status: number;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  bodyPreview?: string;
};
