import { ResidentType, UserRole } from "@prisma/client";
import { Router } from "express";
import { rowsToCsv } from "../../lib/csv";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

function filenameDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** GET /api/export/villas-csv — same columns as POST /api/import/villas-csv */
router.get("/villas-csv", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const villas = await prisma.villa.findMany({
      where: { societyId },
      orderBy: { villaNumber: "asc" },
    });
    const villaIds = villas.map((v) => v.id);

    const owners = await prisma.user.findMany({
      where: {
        societyId,
        villaId: { in: villaIds },
        role: { in: [UserRole.RESIDENT, UserRole.RESIDENT_CUM_ADMIN] },
        residentType: ResidentType.OWNER,
        isActive: true,
      },
      select: { villaId: true, unitId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const ownerUnitByVilla = new Map<string, string | null>();
    for (const o of owners) {
      if (!o.villaId) continue;
      if (!ownerUnitByVilla.has(o.villaId)) {
        ownerUnitByVilla.set(o.villaId, o.unitId);
      }
    }

    const allUnits = await prisma.unit.findMany({
      where: { villaId: { in: villaIds }, societyId },
      orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }],
      select: { id: true, villaId: true },
    });
    const unitOrderByVilla = new Map<string, string[]>();
    for (const u of allUnits) {
      const arr = unitOrderByVilla.get(u.villaId) ?? [];
      arr.push(u.id);
      unitOrderByVilla.set(u.villaId, arr);
    }

    const headers = [
      "villaNumber",
      "floors",
      "area",
      "block",
      "ownerName",
      "ownerEmail",
      "ownerPhone",
      "monthlyMaintenance",
      "defaultFloor",
      "ownerUsername",
      "ownerPassword",
    ];

    const rows = villas.map((v) => {
      const orderedIds = unitOrderByVilla.get(v.id) ?? [];
      const ownerUnitId = ownerUnitByVilla.get(v.id) ?? null;
      let defaultFloor = 0;
      if (ownerUnitId && orderedIds.length > 0) {
        const idx = orderedIds.indexOf(ownerUnitId);
        defaultFloor = idx >= 0 ? idx : 0;
      }
      return [
        v.villaNumber,
        v.floors,
        v.area != null ? Number(v.area) : "",
        v.block ?? "",
        v.ownerName,
        v.ownerEmail ?? "",
        v.ownerPhone ?? "",
        Number(v.monthlyMaintenance),
        defaultFloor,
        "",
        "",
      ];
    });

    const csv = rowsToCsv(headers, rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="villas-export-${filenameDate()}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    next(error);
  }
});

/** GET /api/export/residents-csv — same columns as POST /api/import/residents-csv; password column left empty */
router.get("/residents-csv", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const users = await prisma.user.findMany({
      where: { societyId, role: { in: [UserRole.RESIDENT, UserRole.RESIDENT_CUM_ADMIN] } },
      include: {
        villa: {
          select: {
            villaNumber: true,
            units: {
              orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }],
              select: { id: true },
            },
          },
        },
      },
      orderBy: { username: "asc" },
    });

    const headers = [
      "username",
      "name",
      "email",
      "password",
      "phone",
      "residentType",
      "villaNumber",
      "moveInDate",
      "defaultFloor",
    ];

    const rows = users.map((u) => {
      const moveIn = u.moveInDate != null ? u.moveInDate.toISOString().slice(0, 10) : "";
      const orderedIds = u.villa?.units?.map((x) => x.id) ?? [];
      let defaultFloor = 0;
      if (u.unitId && orderedIds.length > 0) {
        const idx = orderedIds.indexOf(u.unitId);
        defaultFloor = idx >= 0 ? idx : 0;
      }
      return [
        u.username,
        u.name,
        u.email,
        "",
        u.phone ?? "",
        u.residentType,
        u.villa?.villaNumber ?? "",
        moveIn,
        defaultFloor,
      ];
    });

    const csv = rowsToCsv(headers, rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="residents-export-${filenameDate()}.csv"`,
    );
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    next(error);
  }
});

export default router;
