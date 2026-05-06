-- Multi-tenant validation for AdminDashBoard (Prisma / PostgreSQL).
-- Column names use Prisma defaults: "societyId" on models, PascalCase table names.
-- Run after backups; all SELECTs are read-only.
-- Mapping vs generic spec: Villa=flat, Parcel=delivery, MaintenancePayment=maintenance payment,
--   AdminAuditLog=audit, Visitor/Parcel already have societyId like your visitors/deliveries.

-- ---------------------------------------------------------------------------
-- 1) Direct columns: no NULL societyId on tenant-scoped tables
-- ---------------------------------------------------------------------------
SELECT 'User NULL societyId' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "User" WHERE "societyId" IS NULL
UNION ALL
SELECT 'Villa NULL societyId', COUNT(*) FROM "Villa" WHERE "societyId" IS NULL
UNION ALL
SELECT 'Visitor NULL societyId', COUNT(*) FROM "Visitor" WHERE "societyId" IS NULL
UNION ALL
SELECT 'Parcel NULL societyId', COUNT(*) FROM "Parcel" WHERE "societyId" IS NULL
UNION ALL
SELECT 'MaintenancePayment NULL societyId', COUNT(*) FROM "MaintenancePayment" WHERE "societyId" IS NULL
UNION ALL
SELECT 'Maintenance NULL societyId', COUNT(*) FROM "Maintenance" WHERE "societyId" IS NULL
UNION ALL
SELECT 'Gate NULL societyId', COUNT(*) FROM "Gate" WHERE "societyId" IS NULL;

-- Rows that SHOULD have societyId optionally set (informational / drift detection)
SELECT 'payment_logs NULL societyId (optional)' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "payment_logs" WHERE "societyId" IS NULL
UNION ALL
SELECT 'admin_audit_logs NULL societyId (optional)', COUNT(*) FROM "admin_audit_logs" WHERE "societyId" IS NULL;

-- ---------------------------------------------------------------------------
-- 2) Foreign-key alignment: child.societyId must match parent Society
-- (redundant if FKs exist; catches manual DB edits)
-- ---------------------------------------------------------------------------
SELECT 'User.societyId not in Society' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "User" u
LEFT JOIN "Society" s ON s.id = u."societyId"
WHERE s.id IS NULL
UNION ALL
SELECT 'Villa.societyId not in Society', COUNT(*)
FROM "Villa" v
LEFT JOIN "Society" s ON s.id = v."societyId"
WHERE s.id IS NULL;

-- ---------------------------------------------------------------------------
-- 3) Cross-table tenant consistency (common leak vectors)
-- ---------------------------------------------------------------------------
SELECT 'VisitorVilla visitor vs villa society mismatch' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "VisitorVilla" vv
INNER JOIN "Visitor" vi ON vi.id = vv."visitorId"
INNER JOIN "Villa" vl ON vl.id = vv."villaId"
WHERE vi."societyId" IS DISTINCT FROM vl."societyId";

SELECT 'StaffAssignment staff vs villa society mismatch' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "StaffAssignment" sa
INNER JOIN "Staff" st ON st.id = sa."staffId"
INNER JOIN "Villa" vl ON vl.id = sa."villaId"
WHERE st."societyId" IS DISTINCT FROM vl."societyId";

SELECT 'Complaint society vs villa society mismatch' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "Complaint" c
INNER JOIN "Villa" vl ON vl.id = c."villaId"
WHERE c."societyId" IS DISTINCT FROM vl."societyId";

SELECT 'Maintenance society vs villa society mismatch' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "Maintenance" m
INNER JOIN "Villa" vl ON vl.id = m."villaId"
WHERE m."societyId" IS DISTINCT FROM vl."societyId";

SELECT 'MaintenancePayment society vs villa society mismatch' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "MaintenancePayment" mp
INNER JOIN "Villa" vl ON vl.id = mp."villaId"
WHERE mp."societyId" IS DISTINCT FROM vl."societyId";

SELECT 'Parcel society vs villa society mismatch' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "Parcel" p
INNER JOIN "Villa" vl ON vl.id = p."villaId"
WHERE p."societyId" IS DISTINCT FROM vl."societyId";

SELECT 'AmenityBooking society vs amenity mismatch' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "AmenityBooking" ab
INNER JOIN "Amenity" a ON a.id = ab."amenityId"
WHERE ab."societyId" IS DISTINCT FROM a."societyId";

SELECT 'User villa society mismatch (user vs assigned villa)' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "User" u
INNER JOIN "Villa" vl ON vl.id = u."villaId"
WHERE u."societyId" IS DISTINCT FROM vl."societyId";

SELECT 'MaintenancePayment maintenance society mismatch' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "MaintenancePayment" mp
INNER JOIN "Maintenance" m ON m.id = mp."maintenanceId"
WHERE mp."maintenanceId" IS NOT NULL
  AND mp."societyId" IS DISTINCT FROM m."societyId";

SELECT 'BillingCycle vs Society' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "BillingCycle" bc
LEFT JOIN "Society" s ON s.id = bc."societyId"
WHERE s.id IS NULL;

SELECT 'UserCyclePayment user vs BillingCycle society (via cycle)' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "user_payments" ucp
INNER JOIN "User" u ON u.id = ucp."userId"
INNER JOIN "BillingCycle" bc ON bc.id = ucp."cycleId"
WHERE u."societyId" IS DISTINCT FROM bc."societyId";

SELECT 'PollVote villa in same society as poll' AS check_name, COUNT(*)::bigint AS bad_rows
FROM "PollVote" pv
INNER JOIN "Poll" po ON po.id = pv."pollId"
INNER JOIN "Villa" vl ON vl.id = pv."villaId"
WHERE po."societyId" IS DISTINCT FROM vl."societyId";

-- ---------------------------------------------------------------------------
-- 4) Index presence (PostgreSQL usually uses schema "public"; adjust if not)
-- ---------------------------------------------------------------------------
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('User', 'Visitor', 'Parcel', 'Villa', 'MaintenancePayment')
  AND indexdef ILIKE '%societyId%'
ORDER BY tablename, indexname;
