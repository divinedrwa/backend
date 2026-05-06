-- Phase 2: tables and column changes using enums from phase 1 (separate transaction).

-- AlterTable
ALTER TABLE "Expense" ALTER COLUMN "tags" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GuardShift" ADD COLUMN     "recurringDaily" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recurringEndMinutes" INTEGER,
ADD COLUMN     "recurringStartMinutes" INTEGER;

-- AlterTable
ALTER TABLE "Notice" ADD COLUMN     "category" "NoticeCategory" NOT NULL DEFAULT 'GENERAL',
ADD COLUMN     "isUrgent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priority" "NoticePriority" NOT NULL DEFAULT 'NORMAL';

-- AlterTable
ALTER TABLE "SOSAlert" ADD COLUMN     "assignedGuardId" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "escalationNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "inProgressAt" TIMESTAMP(3),
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ALTER COLUMN "status" SET DEFAULT 'CREATED';

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "email" TEXT,
ADD COLUMN     "isApproved" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "VisitorVilla" ADD COLUMN     "approvalStatus" "VisitorVillaApprovalStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "respondedByUserId" TEXT;

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "deviceName" TEXT,
    "platform" "PushPlatform" NOT NULL DEFAULT 'ANDROID',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNotification" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "pushSent" BOOLEAN NOT NULL DEFAULT false,
    "pushError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoticeRecipient" (
    "noticeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "NoticeRecipient_pkey" PRIMARY KEY ("noticeId","userId")
);

-- CreateTable
CREATE TABLE "GateVehicleLedger" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "guardId" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "kind" "GateVehicleKind" NOT NULL DEFAULT 'VISITOR',
    "villaId" TEXT,
    "entryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GateVehicleLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocBroadcast" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "guardId" TEXT NOT NULL,
    "kind" "SocBroadcastKind" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Banner" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "type" "BannerType" NOT NULL DEFAULT 'ANNOUNCEMENT',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "actionUrl" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCycle" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "paymentStartDate" TIMESTAMP(3) NOT NULL,
    "paymentEndDate" TIMESTAMP(3) NOT NULL,
    "lateFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 0,
    "status" "BillingCycleStatus" NOT NULL,
    "windowOpenNotifiedAt" TIMESTAMP(3),
    "dueReminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "amountPaid" DECIMAL(12,2) NOT NULL,
    "paymentStatus" "BillingUserPaymentStatus" NOT NULL,
    "paymentGatewayOrderId" TEXT,
    "paymentGatewayPaymentId" TEXT,
    "source" "BillingPaymentSource" NOT NULL DEFAULT 'GATEWAY',
    "manualMarkedByAdminId" TEXT,
    "invoiceNumber" TEXT,
    "paidAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_late_fee_waivers" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remark" TEXT,

    CONSTRAINT "billing_late_fee_waivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_logs" (
    "id" TEXT NOT NULL,
    "societyId" TEXT,
    "userId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "societyId" TEXT,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PushDevice_userId_idx" ON "PushDevice"("userId");

-- CreateIndex
CREATE INDEX "PushDevice_token_idx" ON "PushDevice"("token");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_userId_deviceId_key" ON "PushDevice"("userId", "deviceId");

-- CreateIndex
CREATE INDEX "UserNotification_userId_createdAt_idx" ON "UserNotification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserNotification_societyId_createdAt_idx" ON "UserNotification"("societyId", "createdAt");

-- CreateIndex
CREATE INDEX "NoticeRecipient_userId_idx" ON "NoticeRecipient"("userId");

-- CreateIndex
CREATE INDEX "GateVehicleLedger_societyId_entryAt_idx" ON "GateVehicleLedger"("societyId", "entryAt");

-- CreateIndex
CREATE INDEX "GateVehicleLedger_guardId_idx" ON "GateVehicleLedger"("guardId");

-- CreateIndex
CREATE INDEX "GateVehicleLedger_registrationNumber_idx" ON "GateVehicleLedger"("registrationNumber");

-- CreateIndex
CREATE INDEX "SocBroadcast_societyId_createdAt_idx" ON "SocBroadcast"("societyId", "createdAt");

-- CreateIndex
CREATE INDEX "Banner_societyId_idx" ON "Banner"("societyId");

-- CreateIndex
CREATE INDEX "Banner_isActive_idx" ON "Banner"("isActive");

-- CreateIndex
CREATE INDEX "Banner_priority_idx" ON "Banner"("priority");

-- CreateIndex
CREATE INDEX "Banner_startDate_idx" ON "Banner"("startDate");

-- CreateIndex
CREATE INDEX "Banner_endDate_idx" ON "Banner"("endDate");

-- CreateIndex
CREATE INDEX "BillingCycle_societyId_idx" ON "BillingCycle"("societyId");

-- CreateIndex
CREATE INDEX "BillingCycle_cycleKey_idx" ON "BillingCycle"("cycleKey");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCycle_societyId_cycleKey_key" ON "BillingCycle"("societyId", "cycleKey");

-- CreateIndex
CREATE UNIQUE INDEX "user_payments_paymentGatewayOrderId_key" ON "user_payments"("paymentGatewayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "user_payments_invoiceNumber_key" ON "user_payments"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "user_payments_idempotencyKey_key" ON "user_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "user_payments_userId_idx" ON "user_payments"("userId");

-- CreateIndex
CREATE INDEX "user_payments_cycleId_idx" ON "user_payments"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "user_payments_userId_cycleId_key" ON "user_payments"("userId", "cycleId");

-- CreateIndex
CREATE INDEX "billing_late_fee_waivers_cycleId_idx" ON "billing_late_fee_waivers"("cycleId");

-- CreateIndex
CREATE INDEX "billing_late_fee_waivers_userId_idx" ON "billing_late_fee_waivers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_late_fee_waivers_cycleId_userId_key" ON "billing_late_fee_waivers"("cycleId", "userId");

-- CreateIndex
CREATE INDEX "payment_logs_userId_idx" ON "payment_logs"("userId");

-- CreateIndex
CREATE INDEX "payment_logs_cycleId_idx" ON "payment_logs"("cycleId");

-- CreateIndex
CREATE INDEX "payment_logs_createdAt_idx" ON "payment_logs"("createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_logs_societyId_createdAt_idx" ON "admin_audit_logs"("societyId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_logs_adminId_idx" ON "admin_audit_logs"("adminId");

-- CreateIndex
CREATE INDEX "Notice_category_idx" ON "Notice"("category");

-- CreateIndex
CREATE INDEX "SOSAlert_assignedGuardId_idx" ON "SOSAlert"("assignedGuardId");

-- CreateIndex
CREATE INDEX "Vendor_isApproved_idx" ON "Vendor"("isApproved");

-- CreateIndex
CREATE INDEX "VisitorVilla_approvalStatus_idx" ON "VisitorVilla"("approvalStatus");

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeRecipient" ADD CONSTRAINT "NoticeRecipient_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeRecipient" ADD CONSTRAINT "NoticeRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorVilla" ADD CONSTRAINT "VisitorVilla_respondedByUserId_fkey" FOREIGN KEY ("respondedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmenityBooking" ADD CONSTRAINT "AmenityBooking_residentId_fkey" FOREIGN KEY ("residentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateVehicleLedger" ADD CONSTRAINT "GateVehicleLedger_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateVehicleLedger" ADD CONSTRAINT "GateVehicleLedger_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateVehicleLedger" ADD CONSTRAINT "GateVehicleLedger_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocBroadcast" ADD CONSTRAINT "SocBroadcast_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocBroadcast" ADD CONSTRAINT "SocBroadcast_guardId_fkey" FOREIGN KEY ("guardId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SOSAlert" ADD CONSTRAINT "SOSAlert_assignedGuardId_fkey" FOREIGN KEY ("assignedGuardId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCycle" ADD CONSTRAINT "BillingCycle_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_payments" ADD CONSTRAINT "user_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_payments" ADD CONSTRAINT "user_payments_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "BillingCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_late_fee_waivers" ADD CONSTRAINT "billing_late_fee_waivers_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "BillingCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_late_fee_waivers" ADD CONSTRAINT "billing_late_fee_waivers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "BillingCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
