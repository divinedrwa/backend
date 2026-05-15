import bcrypt from "bcryptjs";
import { UserRole, ResidentType } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import {
  createSuggestedOccupantUnitsIfMissing,
  ensureBillingAccountForProperty,
  getOrCreateDefaultUnitIdForVilla,
  getUnitIdForVillaFloorIndex,
} from "../../lib/propertyInfrastructure";
import { prisma } from "../../lib/prisma";
import { parseCsvRows, csvRowsToRecords } from "../../lib/csv";
import { requireAuth, requireRole } from "../../middlewares/auth";
import {
  formatUserUniqueConstraintError,
  findOrCreateShellVillaForResident,
  loadVillaLookupMap,
  optionalTrimmedPhone,
  provisionImportedVillaOwnerAccount,
} from "../../services/societyProvisioning";

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
  /** Residents CSV: placeholder villas created when villaNumber was missing in this society */
  villasAutoCreated?: number;
  /** Villas CSV: owner RESIDENT users created for rows with ownerEmail */
  usersCreated?: number;
  /** Villas CSV: login details when a temporary password was generated */
  ownerCredentials?: Array<{
    line: number;
    username: string;
    email: string;
    temporaryPassword?: string;
  }>;
};

function parseMoney(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** POST /api/import/villas-csv — CSV columns: villaNumber,floors,area,block,ownerName,ownerEmail,ownerPhone,monthlyMaintenance — optional: defaultFloor (0 = ground, 1 = first, …), ownerUsername, ownerPassword. Suggested occupant units are created from `floors` (1 → GF only, 2 → GF+FF, 3 → GF+FF+SF, etc.). */
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
    const result: ImportResult = {
      created: 0,
      skipped: 0,
      errors: [],
      usersCreated: 0,
      ownerCredentials: [],
    };

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

      const defaultFloorRaw = (r.defaultFloor ?? "").trim();
      let defaultFloorIndex = 0;
      if (defaultFloorRaw !== "") {
        const df = Number(defaultFloorRaw.replace(/,/g, ""));
        if (!Number.isFinite(df) || df < 0 || df > 99) {
          result.errors.push({
            line,
            message: "defaultFloor must be a non-negative integer (0 = ground floor, 1 = first floor, …)",
          });
          result.skipped++;
          continue;
        }
        defaultFloorIndex = Math.floor(df);
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
        const villa = await prisma.$transaction(async (tx) => {
          const v = await tx.villa.create({
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
          await ensureBillingAccountForProperty(tx, { societyId, villaId: v.id });
          await createSuggestedOccupantUnitsIfMissing(tx, {
            societyId,
            villaId: v.id,
            villaNumber,
            floors,
          });
          return v;
        });
        result.created++;

        const provision = await provisionImportedVillaOwnerAccount({
          societyId,
          villaId: villa.id,
          line,
          ownerName,
          ownerEmail: r.ownerEmail,
          ownerPhone: r.ownerPhone,
          ownerUsernameRaw: r.ownerUsername,
          ownerPasswordRaw: r.ownerPassword,
          defaultFloorIndex,
        });
        if (provision.kind === "created") {
          result.usersCreated = (result.usersCreated ?? 0) + provision.usersCreated;
          if (provision.credential && result.ownerCredentials) {
            result.ownerCredentials.push(provision.credential);
          }
        } else if (provision.kind === "skipped_email_taken") {
          result.errors.push({
            line,
            message: `Owner login not created: email "${provision.email}" is already registered`,
          });
        } else if (provision.kind === "error") {
          result.errors.push({ line: provision.line, message: provision.message });
        }
      } catch (e) {
        result.errors.push({
          line,
          message: e instanceof Error ? e.message : "Create failed",
        });
        result.skipped++;
      }
    }

    if (result.ownerCredentials?.length === 0) delete result.ownerCredentials;
    if (result.usersCreated === 0) delete result.usersCreated;

    return res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

/** POST /api/import/residents-csv — username,name,email,password,phone,residentType,villaNumber,moveInDate — optional: defaultFloor (0 = ground by sort order, 1 = next tier, …). */
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
    const hasDefaultFloorCol = header.includes("defaultFloor");
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

    const villaByNumber = await loadVillaLookupMap(societyId);

    const records = csvRowsToRecords(header, rows.slice(1));
    const result: ImportResult = { created: 0, skipped: 0, errors: [], villasAutoCreated: 0 };

    for (let i = 0; i < records.length; i++) {
      const line = i + 2;
      const r = records[i];
      const username = r.username?.trim().toLowerCase().replace(/\s/g, "");
      const name = r.name?.trim();
      const email = r.email?.trim();
      const password = r.password?.trim();
      const displayVillaNumber = r.villaNumber?.trim() ?? "";
      const phone = optionalTrimmedPhone(r.phone);

      if (!username || username.length < 3 || !name || !email || !password || password.length < 6) {
        result.errors.push({
          line,
          message: "username (min 3), name, email, and password (min 6) are required",
        });
        result.skipped++;
        continue;
      }

      if (!displayVillaNumber) {
        result.errors.push({
          line,
          message: "villaNumber is required",
        });
        result.skipped++;
        continue;
      }

      const villaOutcome = await findOrCreateShellVillaForResident({
        societyId,
        displayVillaNumber,
        placeholderOwnerName: name,
        villaByLookupKey: villaByNumber,
      });
      if (!villaOutcome.ok) {
        result.errors.push({ line, message: villaOutcome.message });
        result.skipped++;
        continue;
      }
      const villaId = villaOutcome.villaId;
      if (villaOutcome.created) {
        result.villasAutoCreated = (result.villasAutoCreated ?? 0) + 1;
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
        let unitId: string | null = null;
        if (!hasDefaultFloorCol) {
          unitId = await getOrCreateDefaultUnitIdForVilla({ societyId, villaId });
        } else {
          const rawDf = (r.defaultFloor ?? "").trim();
          if (rawDf === "") {
            unitId = await getOrCreateDefaultUnitIdForVilla({ societyId, villaId });
          } else {
            const n = Number(rawDf.replace(/,/g, ""));
            if (!Number.isFinite(n) || n < 0 || n > 99) {
              result.errors.push({
                line,
                message: "defaultFloor must be a non-negative integer (0 = ground, 1 = first floor, …)",
              });
              result.skipped++;
              continue;
            }
            unitId = await getUnitIdForVillaFloorIndex(prisma, {
              societyId,
              villaId,
              floorIndex: Math.floor(n),
            });
          }
        }
        if (!unitId) {
          result.errors.push({
            line,
            message:
              "Property has no occupant units. Add units to this villa (Villas page) before importing residents.",
          });
          result.skipped++;
          continue;
        }
        await prisma.user.create({
          data: {
            societyId,
            username,
            name,
            email,
            phone,
            passwordHash,
            role: UserRole.RESIDENT,
            residentType,
            villaId,
            unitId,
            moveInDate: moveIn,
            isActive: true,
          },
        });
        result.created++;
      } catch (e) {
        result.errors.push({
          line,
          message: formatUserUniqueConstraintError(e),
        });
        result.skipped++;
      }
    }

    if (result.villasAutoCreated === 0) delete result.villasAutoCreated;

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
      const phone = optionalTrimmedPhone(r.phone);

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
            phone,
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
          message: formatUserUniqueConstraintError(e),
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
