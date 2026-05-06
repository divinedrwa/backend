import bcrypt from "bcryptjs";
import { UserRole, ResidentType } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { prisma } from "../../lib/prisma";
import { parseCsvRows, csvRowsToRecords } from "../../lib/csv";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

type ImportResult = {
  created: number;
  skipped: number;
  errors: Array<{ line: number; message: string }>;
};

function parseMoney(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** POST /api/import/villas-csv — CSV columns: villaNumber,floors,area,block,ownerName,ownerEmail,ownerPhone,monthlyMaintenance */
router.post("/villas-csv", upload.single("file"), async (req, res, next) => {
  try {
    const buf = req.file?.buffer;
    if (!buf?.length) {
      return res.status(400).json({ message: "Missing CSV file (field name: file)" });
    }
    const societyId = req.auth!.societyId;
    const text = buf.toString("utf8");
    const rows = parseCsvRows(text);
    if (rows.length < 2) {
      return res.status(400).json({ message: "CSV must include a header row and at least one data row" });
    }

    const header = rows[0].map((h) => h.trim());
    const expected = [
      "villaNumber",
      "floors",
      "area",
      "block",
      "ownerName",
      "ownerEmail",
      "ownerPhone",
      "monthlyMaintenance",
    ];
    const missing = expected.filter((k) => !header.includes(k));
    if (missing.length > 0) {
      return res.status(400).json({
        message: `CSV header must include columns: ${expected.join(", ")}`,
        missingColumns: missing,
      });
    }

    const records = csvRowsToRecords(header, rows.slice(1));
    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    for (let i = 0; i < records.length; i++) {
      const line = i + 2;
      const r = records[i];
      const villaNumber = r.villaNumber?.trim();
      const ownerName = r.ownerName?.trim();
      if (!villaNumber || !ownerName) {
        result.errors.push({ line, message: "villaNumber and ownerName are required" });
        result.skipped++;
        continue;
      }

      const floorsRaw = parseMoney(r.floors ?? "1");
      const floors = floorsRaw != null ? Math.round(floorsRaw) : 1;
      if (floors < 1 || floors > 10) {
        result.errors.push({ line, message: "floors must be between 1 and 10" });
        result.skipped++;
        continue;
      }

      const areaVal = parseMoney(r.area ?? "");
      const maintenance = parseMoney(r.monthlyMaintenance ?? "");
      if (maintenance == null || maintenance <= 0) {
        result.errors.push({ line, message: "monthlyMaintenance must be a positive number" });
        result.skipped++;
        continue;
      }

      const dup = await prisma.villa.findFirst({
        where: { societyId, villaNumber },
      });
      if (dup) {
        result.errors.push({ line, message: `Villa number "${villaNumber}" already exists` });
        result.skipped++;
        continue;
      }

      try {
        await prisma.villa.create({
          data: {
            societyId,
            villaNumber,
            floors,
            area:
              areaVal != null && areaVal > 0
                ? areaVal
                : undefined,
            block: r.block?.trim() || undefined,
            ownerName,
            ownerEmail: r.ownerEmail?.trim() || undefined,
            ownerPhone: r.ownerPhone?.trim() || undefined,
            monthlyMaintenance: maintenance,
          },
        });
        result.created++;
      } catch (e) {
        result.errors.push({
          line,
          message: e instanceof Error ? e.message : "Create failed",
        });
        result.skipped++;
      }
    }

    return res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

/** POST /api/import/residents-csv — username,name,email,password,phone,residentType,villaNumber,moveInDate */
router.post("/residents-csv", upload.single("file"), async (req, res, next) => {
  try {
    const buf = req.file?.buffer;
    if (!buf?.length) {
      return res.status(400).json({ message: "Missing CSV file (field name: file)" });
    }
    const societyId = req.auth!.societyId;
    const text = buf.toString("utf8");
    const rows = parseCsvRows(text);
    if (rows.length < 2) {
      return res.status(400).json({ message: "CSV must include a header row and at least one data row" });
    }

    const header = rows[0].map((h) => h.trim());
    const expected = [
      "username",
      "name",
      "email",
      "password",
      "phone",
      "residentType",
      "villaNumber",
      "moveInDate",
    ];
    const missing = expected.filter((k) => !header.includes(k));
    if (missing.length > 0) {
      return res.status(400).json({
        message: `CSV header must include columns: ${expected.join(", ")}`,
        missingColumns: missing,
      });
    }

    const villas = await prisma.villa.findMany({
      where: { societyId },
      select: { id: true, villaNumber: true },
    });
    const villaByNumber = new Map(
      villas.map((v) => [v.villaNumber.trim().toLowerCase(), v.id] as const),
    );

    const records = csvRowsToRecords(header, rows.slice(1));
    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    for (let i = 0; i < records.length; i++) {
      const line = i + 2;
      const r = records[i];
      const username = r.username?.trim().toLowerCase().replace(/\s/g, "");
      const name = r.name?.trim();
      const email = r.email?.trim();
      const password = r.password?.trim();
      const villaNumber = r.villaNumber?.trim().toLowerCase();

      if (!username || username.length < 3 || !name || !email || !password || password.length < 6) {
        result.errors.push({
          line,
          message: "username (min 3), name, email, and password (min 6) are required",
        });
        result.skipped++;
        continue;
      }

      const villaId = villaNumber ? villaByNumber.get(villaNumber) : undefined;
      if (!villaId) {
        result.errors.push({
          line,
          message: `Unknown villaNumber "${r.villaNumber?.trim() ?? ""}" for this society`,
        });
        result.skipped++;
        continue;
      }

      let residentType: ResidentType = ResidentType.OWNER;
      const rt = (r.residentType ?? "OWNER").trim().toUpperCase();
      if (rt === "TENANT") residentType = ResidentType.TENANT;
      else if (rt === "FAMILY_MEMBER" || rt === "FAMILY") residentType = ResidentType.FAMILY_MEMBER;

      let moveIn = new Date();
      if (r.moveInDate?.trim()) {
        const d = new Date(r.moveInDate.trim());
        if (!Number.isNaN(d.getTime())) moveIn = d;
      }

      const existing = await prisma.user.findFirst({
        where: {
          OR: [{ username }, { email }],
        },
      });
      if (existing) {
        result.errors.push({
          line,
          message:
            existing.username === username
              ? `Username "${username}" already exists`
              : `Email "${email}" already exists`,
        });
        result.skipped++;
        continue;
      }

      try {
        const passwordHash = await bcrypt.hash(password, 10);
        await prisma.user.create({
          data: {
            societyId,
            username,
            name,
            email,
            phone: r.phone?.trim() || undefined,
            passwordHash,
            role: UserRole.RESIDENT,
            residentType,
            villaId,
            moveInDate: moveIn,
            isActive: true,
          },
        });
        result.created++;
      } catch (e) {
        result.errors.push({
          line,
          message: e instanceof Error ? e.message : "Create failed",
        });
        result.skipped++;
      }
    }

    return res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

/** POST /api/import/guards-csv — username,name,email,password,phone */
router.post("/guards-csv", upload.single("file"), async (req, res, next) => {
  try {
    const buf = req.file?.buffer;
    if (!buf?.length) {
      return res.status(400).json({ message: "Missing CSV file (field name: file)" });
    }
    const societyId = req.auth!.societyId;
    const text = buf.toString("utf8");
    const rows = parseCsvRows(text);
    if (rows.length < 2) {
      return res.status(400).json({ message: "CSV must include a header row and at least one data row" });
    }

    const header = rows[0].map((h) => h.trim());
    const expected = ["username", "name", "email", "password", "phone"];
    const missing = expected.filter((k) => !header.includes(k));
    if (missing.length > 0) {
      return res.status(400).json({
        message: `CSV header must include columns: ${expected.join(", ")}`,
        missingColumns: missing,
      });
    }

    const records = csvRowsToRecords(header, rows.slice(1));
    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    for (let i = 0; i < records.length; i++) {
      const line = i + 2;
      const r = records[i];
      const username = r.username?.trim().toLowerCase().replace(/\s/g, "");
      const name = r.name?.trim();
      const email = r.email?.trim();
      const password = r.password?.trim();

      if (!username || username.length < 3 || !name || !email || !password || password.length < 6) {
        result.errors.push({
          line,
          message: "username (min 3), name, email, and password (min 6) are required",
        });
        result.skipped++;
        continue;
      }

      const existing = await prisma.user.findFirst({
        where: {
          OR: [{ username }, { email }],
        },
      });
      if (existing) {
        result.errors.push({
          line,
          message:
            existing.username === username
              ? `Username "${username}" already exists`
              : `Email "${email}" already exists`,
        });
        result.skipped++;
        continue;
      }

      try {
        const passwordHash = await bcrypt.hash(password, 10);
        await prisma.user.create({
          data: {
            societyId,
            username,
            name,
            email,
            phone: r.phone?.trim() || undefined,
            passwordHash,
            role: UserRole.GUARD,
            residentType: ResidentType.OWNER,
            isActive: true,
          },
        });
        result.created++;
      } catch (e) {
        result.errors.push({
          line,
          message: e instanceof Error ? e.message : "Create failed",
        });
        result.skipped++;
      }
    }

    return res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
