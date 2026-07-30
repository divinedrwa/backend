import { createHash } from "node:crypto";
import type { Request } from "express";
import {
  NotificationCategory,
  UserRole,
  VisitorStatus,
  type PrismaClient,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { expectedCheckoutAtForVisitorType } from "../lib/visitorTypePresets";
import { notifyUsers, notifySocietyRoles } from "./notification.service";
import { residentLikeRoleFilter } from "../lib/residentLike";

export function hashPassViewIp(ip: string | undefined): string | null {
  const trimmed = ip?.trim();
  if (!trimmed) return null;
  return createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 32);
}

export function passViewUserAgent(req: Request): string | null {
  const ua = req.get("user-agent")?.trim();
  if (!ua) return null;
  return ua.slice(0, 512);
}

/** Fire-and-forget: record a public pass page open. */
export function recordPreApprovedPassView(
  db: PrismaClient,
  preApprovedId: string,
  req: Request,
): void {
  void db.preApprovedPassView
    .create({
      data: {
        preApprovedId,
        ipHash: hashPassViewIp(req.ip),
        userAgent: passViewUserAgent(req),
      },
    })
    .catch((err) => {
      logger.debug({ err, preApprovedId }, "[pass-view] audit insert failed");
    });
}

export async function revokePreApprovedPublicLink(
  db: PrismaClient,
  p: {
    id: string;
    societyId: string;
    role: UserRole;
    actorVillaId?: string | null;
  },
): Promise<void> {
  const existing = await db.preApprovedVisitor.findFirst({
    where: { id: p.id, societyId: p.societyId },
    select: { id: true, villaId: true, isActive: true },
  });
  if (!existing) {
    const err = new Error("Pre-approved visitor not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }
  if (
    p.role === UserRole.RESIDENT &&
    (!p.actorVillaId || existing.villaId !== p.actorVillaId)
  ) {
    const err = new Error("Cannot revoke link for another villa");
    (err as Error & { statusCode: number }).statusCode = 403;
    throw err;
  }

  await db.preApprovedVisitor.update({
    where: { id: existing.id },
    data: {
      publicPassTokenHash: null,
      publicPassIssuedAt: null,
    },
  });
}

export async function listPreApprovedPassViews(
  db: PrismaClient,
  p: {
    id: string;
    societyId: string;
    role: UserRole;
    actorVillaId?: string | null;
    limit?: number;
  },
) {
  const existing = await db.preApprovedVisitor.findFirst({
    where: { id: p.id, societyId: p.societyId },
    select: { id: true, villaId: true },
  });
  if (!existing) {
    const err = new Error("Pre-approved visitor not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }
  if (
    p.role === UserRole.RESIDENT &&
    (!p.actorVillaId || existing.villaId !== p.actorVillaId)
  ) {
    const err = new Error("Cannot view pass audit for another villa");
    (err as Error & { statusCode: number }).statusCode = 403;
    throw err;
  }

  const take = Math.min(Math.max(p.limit ?? 20, 1), 50);
  const [views, total] = await Promise.all([
    db.preApprovedPassView.findMany({
      where: { preApprovedId: existing.id },
      orderBy: { viewedAt: "desc" },
      take,
      select: {
        id: true,
        viewedAt: true,
        userAgent: true,
      },
    }),
    db.preApprovedPassView.count({ where: { preApprovedId: existing.id } }),
  ]);

  return { views, total };
}

/** Notify residents + guards when a checked-in visitor exceeds expected checkout. */
export async function processVisitorOverstayAlerts(): Promise<{
  notified: number;
}> {
  const now = new Date();
  const overstays = await prisma.visitor.findMany({
    where: {
      status: VisitorStatus.CHECKED_IN,
      checkOutAt: null,
      expectedCheckoutAt: { lt: now },
      overstayNotifiedAt: null,
    },
    include: {
      villaVisits: {
        select: {
          villaId: true,
          villa: { select: { villaNumber: true, block: true } },
        },
      },
    },
    take: 100,
  });

  if (overstays.length === 0) return { notified: 0 };

  let notified = 0;
  for (const visitor of overstays) {
    const claimed = await prisma.visitor.updateMany({
      where: {
        id: visitor.id,
        overstayNotifiedAt: null,
        status: VisitorStatus.CHECKED_IN,
        checkOutAt: null,
      },
      data: { overstayNotifiedAt: now },
    });
    if (claimed.count === 0) continue;

    const villaIds = [...new Set(visitor.villaVisits.map((v) => v.villaId))];
    const flatLabel = visitor.villaVisits
      .map((v) => [v.villa.block, v.villa.villaNumber].filter(Boolean).join(" "))
      .filter(Boolean)
      .join(", ");

    try {
      const residents =
        villaIds.length > 0
          ? await prisma.user.findMany({
              where: {
                societyId: visitor.societyId,
                villaId: { in: villaIds },
                ...residentLikeRoleFilter,
                isActive: true,
              },
              select: { id: true },
              distinct: ["id"],
            })
          : [];

      const payload = {
        title: "Visitor overstay alert",
        body: `${visitor.name} has been inside longer than expected${flatLabel ? ` (${flatLabel})` : ""}.`,
        data: {
          type: "VISITOR_OVERSTAY",
          visitorId: visitor.id,
          visitorName: visitor.name,
          visitorType: visitor.visitorType,
        },
      };

      if (residents.length > 0) {
        await notifyUsers(
          residents.map((r) => r.id),
          payload,
          { category: NotificationCategory.VISITOR },
        );
      }

      await notifySocietyRoles({
        societyId: visitor.societyId,
        roles: [UserRole.GUARD],
        title: payload.title,
        body: payload.body,
        data: payload.data,
        category: NotificationCategory.VISITOR,
      });

      notified += 1;
    } catch (err) {
      logger.error({ err, visitorId: visitor.id }, "[overstay] notify failed");
      await prisma.visitor.update({
        where: { id: visitor.id },
        data: { overstayNotifiedAt: null },
      });
    }
  }

  return { notified };
}

export { expectedCheckoutAtForVisitorType };
