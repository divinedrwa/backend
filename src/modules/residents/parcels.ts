import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { ParcelStatus, UserRole } from "@prisma/client";

const router = Router();

router.use(requireAuth);

// GET /api/residents/my-parcels - Get my parcels
router.get("/my-parcels", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { status } = req.query;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const parcels = await prisma.parcel.findMany({
      where: {
        villaId: user.villaId,
        societyId,
        ...(status && { status: status as any }),
      },
      orderBy: { receivedAt: "desc" },
      take: 50,
    });

    const pending = parcels.filter((p) => p.status === ParcelStatus.RECEIVED);
    const collected = parcels.filter(
      (p) => p.status === ParcelStatus.COLLECTED || p.status === ParcelStatus.DELIVERED,
    );

    return res.json({
      parcels,
      summary: {
        total: parcels.length,
        pending: pending.length,
        collected: collected.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/parcels-pending - Get pending parcels
router.get("/parcels-pending", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Cap pending-parcel reads. Mobile clients show this as a small list,
    // not an unbounded export, so 100 is generous.
    const pendingParcels = await prisma.parcel.findMany({
      where: {
        villaId: user.villaId,
        societyId,
        status: ParcelStatus.RECEIVED,
      },
      orderBy: { receivedAt: "desc" },
      take: 100,
    });

    return res.json({
      parcels: pendingParcels,
      count: pendingParcels.length,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/residents/parcels/:id/collected - Mark parcel as collected
router.patch("/parcels/:id/collected", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Verify parcel belongs to user's villa
    const parcel = await prisma.parcel.findFirst({
      where: {
        id,
        villaId: user.villaId,
        societyId,
      },
    });

    if (!parcel) {
      return res.status(404).json({ message: "Parcel not found" });
    }

    if (parcel.status === ParcelStatus.COLLECTED || parcel.status === ParcelStatus.DELIVERED) {
      return res.status(400).json({ message: "Parcel already collected" });
    }

    const updated = await prisma.parcel.update({
      where: { id },
      data: {
        status: ParcelStatus.COLLECTED,
        collectedAt: new Date(),
      },
    });

    return res.json({
      message: "Parcel marked as collected",
      parcel: updated,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
