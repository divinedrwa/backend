import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ---------------------------------------------------------------------------
// Shared component schemas
// ---------------------------------------------------------------------------
const bearerAuth = registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// ---------------------------------------------------------------------------
// Auth schemas
// ---------------------------------------------------------------------------
const LoginRequest = registry.register(
  "LoginRequest",
  z.object({
    societyId: z.string().min(1).openapi({ example: "clx..." }),
    username: z.string().min(3).openapi({ example: "admin" }),
    password: z.string().min(6).openapi({ example: "ChangeMe123!" }),
  }),
);

const LoginResponse = registry.register(
  "LoginResponse",
  z.object({
    token: z.string(),
    refreshToken: z.string(),
    user: z.object({
      id: z.string(),
      username: z.string(),
      role: z.string(),
      societyId: z.string().nullable(),
    }),
  }),
);

const RefreshRequest = registry.register(
  "RefreshRequest",
  z.object({ refreshToken: z.string().min(1) }),
);

const RefreshResponse = registry.register(
  "RefreshResponse",
  z.object({ token: z.string(), refreshToken: z.string() }),
);

// ---------------------------------------------------------------------------
// Billing schemas
// ---------------------------------------------------------------------------
const CreateOrderRequest = registry.register(
  "CreateOrderRequest",
  z.object({
    cycleId: z.string().min(1).optional(),
    payAllPending: z.boolean().optional(),
    idempotencyKey: z.string().min(8).max(120).optional(),
  }),
);

const PhonePeInitiateRequest = registry.register(
  "PhonePeInitiateRequest",
  z.object({
    cycleId: z.string().min(1).optional(),
    payAllPending: z.boolean().optional(),
    idempotencyKey: z.string().min(8).max(120).optional(),
  }),
);

const MarkCashRequest = registry.register(
  "MarkCashRequest",
  z.object({
    userId: z.string().min(1),
    cycleId: z.string().min(1),
    amountPaid: z.number().positive(),
    note: z.string().max(500).optional(),
  }),
);

const ErrorResponse = registry.register(
  "ErrorResponse",
  z.object({
    message: z.string(),
    issues: z.array(z.object({
      path: z.array(z.string()),
      message: z.string(),
    })).optional(),
  }),
);

// ---------------------------------------------------------------------------
// Guard schemas (mobile offline sync + typed clients)
// ---------------------------------------------------------------------------
const GuardVisitTarget = z.object({
  villaId: z.string().min(1),
  unitId: z.string().optional(),
  residentUserId: z.string().optional(),
});

const GuardVisitorCheckInRequest = registry.register(
  "GuardVisitorCheckInRequest",
  z.object({
    name: z.string().trim().min(2),
    phone: z.string().trim().min(10),
    visitTargets: z.array(GuardVisitTarget).optional(),
    villaIds: z.array(z.string()).optional(),
    visitorType: z.enum(["GUEST", "DELIVERY", "SERVICE_PROVIDER", "VENDOR"]),
    purpose: z.string().trim().optional(),
    vehicleNumber: z.string().trim().optional(),
    photo: z.string().optional(),
    awaitResidentApproval: z.boolean().optional(),
    clientMutationId: z.string().uuid().optional(),
  }),
);

const GuardVisitorCheckOutRequest = registry.register(
  "GuardVisitorCheckOutRequest",
  z.object({
    visitorId: z.string(),
    clientMutationId: z.string().uuid().optional(),
  }),
);

const GuardVisitorMutationResponse = registry.register(
  "GuardVisitorMutationResponse",
  z.object({
    message: z.string(),
    visitor: z.record(z.unknown()).optional(),
    awaitResidentApproval: z.boolean().optional(),
    residentApprovalRecipientCount: z.number().optional(),
    idempotentReplay: z.boolean().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/api/auth/login",
  summary: "Tenant user login",
  tags: ["Auth"],
  request: { body: { content: { "application/json": { schema: LoginRequest } } } },
  responses: {
    200: { description: "Login successful", content: { "application/json": { schema: LoginResponse } } },
    401: { description: "Invalid credentials", content: { "application/json": { schema: ErrorResponse } } },
    429: { description: "Rate limited" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/admin/login",
  summary: "Society admin login",
  tags: ["Auth"],
  request: { body: { content: { "application/json": { schema: LoginRequest } } } },
  responses: {
    200: { description: "Login successful", content: { "application/json": { schema: LoginResponse } } },
    401: { description: "Invalid credentials" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/refresh",
  summary: "Refresh access token",
  tags: ["Auth"],
  request: { body: { content: { "application/json": { schema: RefreshRequest } } } },
  responses: {
    200: { description: "Token refreshed", content: { "application/json": { schema: RefreshResponse } } },
    401: { description: "Invalid or expired refresh token" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/payments/create-order",
  summary: "Create Razorpay order for maintenance payment",
  tags: ["Billing"],
  security: [{ [bearerAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: CreateOrderRequest } } } },
  responses: {
    200: { description: "Order created" },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/payments/phonepe/initiate",
  summary: "Initiate PhonePe payment",
  tags: ["Billing"],
  security: [{ [bearerAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: PhonePeInitiateRequest } } } },
  responses: {
    200: { description: "Payment initiated with redirect URL" },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/payments/phonepe/status/{txnId}",
  summary: "Check PhonePe payment status",
  tags: ["Billing"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ txnId: z.string() }),
  },
  responses: {
    200: { description: "Payment status" },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/admin/payments/mark-cash",
  summary: "Record cash payment (admin)",
  tags: ["Billing"],
  security: [{ [bearerAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: MarkCashRequest } } } },
  responses: {
    200: { description: "Payment recorded" },
    400: { description: "Validation error" },
    403: { description: "Forbidden" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/residents/maintenance-pending",
  summary: "Get pending maintenance dues for current resident",
  tags: ["Maintenance"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Pending dues list" },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/residents/maintenance-dashboard",
  summary: "Resident maintenance financial dashboard",
  tags: ["Maintenance"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    query: z.object({
      month: z.string().openapi({ example: "3" }),
      year: z.string().openapi({ example: "2026" }),
      cycleId: z.string().optional(),
      billingCycleId: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Dashboard data" },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/guards/visitor-checkin",
  summary: "Guard walk-in visitor check-in",
  tags: ["Guard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      content: { "application/json": { schema: GuardVisitorCheckInRequest } },
    },
  },
  responses: {
    201: {
      description: "Visitor checked in",
      content: { "application/json": { schema: GuardVisitorMutationResponse } },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized" },
    409: { description: "Duplicate active check-in" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/guards/visitor-checkout",
  summary: "Guard visitor check-out",
  tags: ["Guard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      content: { "application/json": { schema: GuardVisitorCheckOutRequest } },
    },
  },
  responses: {
    200: {
      description: "Visitor checked out (idempotent on replay)",
      content: { "application/json": { schema: GuardVisitorMutationResponse } },
    },
    404: { description: "Visitor not found" },
    409: { description: "Concurrent state change" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/guards/my-visitors",
  summary: "Today's visitors for guard",
  tags: ["Guard"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Visitor list" },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/guards/my-dashboard",
  summary: "Guard dashboard summary",
  tags: ["Guard"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Dashboard data" },
    401: { description: "Unauthorized" },
  },
});

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------
export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "GatePass+ API",
      version: "1.0.0",
      description: "Multi-tenant housing society platform API",
    },
    servers: [{ url: "http://localhost:4000", description: "Local dev" }],
  });
}
