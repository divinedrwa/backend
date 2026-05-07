import { UserRole } from "@prisma/client";
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

    const headers = [
      "villaNumber",
      "floors",
      "area",
      "block",
      "ownerName",
      "ownerEmail",
      "ownerPhone",
      "monthlyMaintenance",
      "ownerUsername",
      "ownerPassword",
    ];

    const rows = villas.map((v) => [
      v.villaNumber,
      v.floors,
      v.area != null ? Number(v.area) : "",
      v.block ?? "",
      v.ownerName,
      v.ownerEmail ?? "",
      v.ownerPhone ?? "",
      Number(v.monthlyMaintenance),
      "",
      "",
    ]);

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
      where: { societyId, role: UserRole.RESIDENT },
      include: {
        villa: { select: { villaNumber: true } },
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
    ];

    const rows = users.map((u) => {
      const moveIn = u.moveInDate != null ? u.moveInDate.toISOString().slice(0, 10) : "";
      return [
        u.username,
        u.name,
        u.email,
        "",
        u.phone ?? "",
        u.residentType,
        u.villa?.villaNumber ?? "",
        moveIn,
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
