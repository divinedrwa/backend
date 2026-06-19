import { NoticeCategory, NoticePriority, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { residentLikeRoleFilter } from "../../lib/residentLike";
import {
  broadcastNoticeToAllResidents,
  broadcastNoticeToSelectedResidents,
} from "../../services/notification.service";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { auditFromRequest } from "../../services/audit.service";

const router = Router();

/** Empty string / null from JSON clients must not fail validation (optional URL only). */
function emptyToUndefined(v: unknown): unknown {
  if (v === "" || v === null || v === undefined) return undefined;
  return v;
}

const optionalHttpUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

const createNoticeSchema = z.object({
  title: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(3).max(200)),
  content: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(10)),
  fileUrl: optionalHttpUrl,
  /** Matches resident app notice filters (GENERAL, MAINTENANCE, EVENT, …). */
  category: z.nativeEnum(NoticeCategory).optional().default(NoticeCategory.GENERAL),
  priority: z.nativeEnum(NoticePriority).optional().default(NoticePriority.NORMAL),
  /** Show in urgent section on mobile; also implied for EMERGENCY / URGENT. */
  isUrgent: z.boolean().optional().default(false),
  /** Notify all active residents via push + in-app inbox */
  notifyResidents: z.boolean().optional().default(true),
  /** If non-empty, only these resident accounts see the notice & get notified (society + active RESIDENT). */
  recipientUserIds: z.array(z.string().cuid()).max(200).optional().default([]),
});

const updateNoticeSchema = z.object({
  title: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(3).max(200).optional()),
  content: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(10).optional()),
  fileUrl: optionalHttpUrl,
  category: z.nativeEnum(NoticeCategory).optional(),
  priority: z.nativeEnum(NoticePriority).optional(),
  isUrgent: z.boolean().optional(),
  /** Replace targeting: omit = unchanged; [] = society-wide; non-empty = only those residents */
  recipientUserIds: z.array(z.string().cuid()).max(200).optional(),
});

async function resolveValidatedResidentRecipientIds(
  societyId: string,
  requested: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; invalidIds: string[] }> {
  const unique = [...new Set(requested)];
  if (unique.length === 0) {
    return { ok: true, ids: [] };
  }

  const rows = await prisma.user.findMany({
    where: {
      id: { in: unique },
      societyId,
      // Include admins who occupy a villa so a notice can be targeted to a
      // resident who is also an admin (same occupant role set used elsewhere).
      ...residentLikeRoleFilter,
      isActive: true,
    },
    select: { id: true },
  });

  const found = new Set(rows.map((r) => r.id));
  const invalidIds = unique.filter((id) => !found.has(id));
  if (invalidIds.length > 0) {
    return { ok: false, invalidIds };
  }

  return { ok: true, ids: unique };
}

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where = { societyId: req.auth!.societyId };
    const [notices, total] = await Promise.all([
      prisma.notice.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
        include: {
          recipients: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  villa: { select: { villaNumber: true, block: true } },
                },
              },
            },
          },
        },
      }),
      prisma.notice.count({ where }),
    ]);
    return res.json({ notices, ...paginationMeta(total, notices.length, pagination) });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createNoticeSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createNoticeSchema>;
      const societyId = req.auth!.societyId;

      const recipientResolved = await resolveValidatedResidentRecipientIds(
        societyId,
        body.recipientUserIds ?? [],
      );
      if (!recipientResolved.ok) {
        return res.status(400).json({
          message:
            "Some recipient IDs are not active residents in this society.",
          invalidUserIds: recipientResolved.invalidIds,
        });
      }

      const isUrgent =
        body.isUrgent ||
        body.category === NoticeCategory.EMERGENCY ||
        body.priority === NoticePriority.URGENT;

      const notice = await prisma.$transaction(async (tx) => {
        const n = await tx.notice.create({
          data: {
            societyId,
            title: body.title,
            content: body.content,
            fileUrl: body.fileUrl,
            category: body.category,
            priority: body.priority,
            isUrgent,
          },
        });

        if (recipientResolved.ids.length > 0) {
          await tx.noticeRecipient.createMany({
            data: recipientResolved.ids.map((userId) => ({
              noticeId: n.id,
              userId,
            })),
          });
        }

        return n;
      });

      if (body.notifyResidents) {
        const preview =
          body.content.length > 220 ? `${body.content.slice(0, 220)}…` : body.content;
        const data = {
          type: "notice",
          noticeId: notice.id,
          societyId,
          audience: recipientResolved.ids.length > 0 ? "SELECTED" : "SOCIETY",
        };
        if (recipientResolved.ids.length > 0) {
          void broadcastNoticeToSelectedResidents({
            societyId,
            title: body.title,
            body: preview,
            data,
            userIds: recipientResolved.ids,
          }).catch((err) => logger.error({ err }, "[notifications] targeted notice failed"));
        } else {
          void broadcastNoticeToAllResidents({
            societyId,
            title: body.title,
            body: preview,
            data,
          }).catch((err) => logger.error({ err }, "[notifications] notice broadcast failed"));
        }
      }

      const withMeta = await prisma.notice.findUnique({
        where: { id: notice.id },
        include: {
          recipients: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  villa: { select: { villaNumber: true, block: true } },
                },
              },
            },
          },
        },
      });

      return res.status(201).json({ notice: withMeta });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateNoticeSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updateNoticeSchema>;
      const { id } = req.params;

      const societyId = req.auth!.societyId;
      const existing = await prisma.notice.findFirst({
        where: { id, societyId },
      });
      if (!existing) {
        return res.status(404).json({ message: "Notice not found" });
      }

      let validatedRecipientIds: string[] | undefined;
      if (body.recipientUserIds !== undefined) {
        const recipientResolved = await resolveValidatedResidentRecipientIds(
          societyId,
          body.recipientUserIds,
        );
        if (!recipientResolved.ok) {
          return res.status(400).json({
            message:
              "Some recipient IDs are not active residents in this society.",
            invalidUserIds: recipientResolved.invalidIds,
          });
        }
        validatedRecipientIds = recipientResolved.ids;
      }

      const category = body.category ?? existing.category;
      const priority = body.priority ?? existing.priority;
      const isUrgent =
        body.isUrgent ?? (category === NoticeCategory.EMERGENCY || priority === NoticePriority.URGENT);

      await prisma.$transaction(async (tx) => {
        await tx.notice.update({
          where: { id },
          data: {
            ...(body.title !== undefined && { title: body.title }),
            ...(body.content !== undefined && { content: body.content }),
            ...(body.fileUrl !== undefined && { fileUrl: body.fileUrl }),
            ...(body.category !== undefined && { category: body.category }),
            ...(body.priority !== undefined && { priority: body.priority }),
            isUrgent,
          },
        });

        if (validatedRecipientIds !== undefined) {
          await tx.noticeRecipient.deleteMany({ where: { noticeId: id } });
          if (validatedRecipientIds.length > 0) {
            await tx.noticeRecipient.createMany({
              data: validatedRecipientIds.map((userId) => ({
                noticeId: id,
                userId,
              })),
            });
          }
        }
      });

      return res.json({ message: "Notice updated" });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  "/:id",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const notice = await prisma.notice.deleteMany({
        where: {
          id,
          societyId: req.auth!.societyId
        }
      });

      if (notice.count === 0) {
        return res.status(404).json({ message: "Notice not found" });
      }

      auditFromRequest(req, {
        adminId: req.auth!.userId,
        societyId: req.auth!.societyId,
        action: "NOTICE_DELETED",
        entityType: "Notice",
        entityId: id,
      });

      return res.json({ message: "Notice deleted" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
