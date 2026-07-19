import { AppAnalyticsEventKind, AppAnalyticsPlatform, UserRole } from "@prisma/client";
import { z } from "zod";

export const platformSchema = z.nativeEnum(AppAnalyticsPlatform);

export const startSessionSchema = z.object({
  platform: platformSchema,
  appVersion: z.string().max(32).optional(),
  buildNumber: z.string().max(32).optional(),
  deviceId: z.string().max(128).optional(),
  deviceModel: z.string().max(128).optional(),
  osVersion: z.string().max(64).optional(),
  clientSessionId: z.string().max(128).optional(),
});

export const patchSessionSchema = z.object({
  ended: z.boolean().optional(),
  heartbeat: z.boolean().optional(),
});

export const eventKindSchema = z.nativeEnum(AppAnalyticsEventKind);

export const analyticsEventSchema = z.object({
  kind: eventKindSchema,
  name: z.string().min(1).max(200),
  sessionId: z.string().cuid().optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  success: z.boolean().optional(),
  properties: z.record(z.unknown()).optional(),
  clientEventId: z.string().min(8).max(128),
  platform: platformSchema.optional(),
  appVersion: z.string().max(32).optional(),
  occurredAt: z.string().datetime().optional(),
});

export const batchEventsSchema = z.object({
  events: z.array(analyticsEventSchema).min(1).max(50),
});

export const summaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export type StartSessionInput = z.infer<typeof startSessionSchema>;
export type AnalyticsEventInput = z.infer<typeof analyticsEventSchema>;

export const ADMIN_READ_ROLES = [UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN] as const;

export const INGEST_ROLES = [
  UserRole.ADMIN,
  UserRole.RESIDENT_CUM_ADMIN,
  UserRole.RESIDENT,
  UserRole.GUARD,
] as const;
