-- Add composite indexes for common query patterns

-- User: resident directory, guard contacts, notification targeting
CREATE INDEX "User_societyId_role_isActive_idx" ON "User"("societyId", "role", "isActive");

-- Visitor: gate analytics date range queries
CREATE INDEX "Visitor_societyId_checkInAt_idx" ON "Visitor"("societyId", "checkInAt");

-- AmenityBooking: booking conflict check
CREATE INDEX "AmenityBooking_amenityId_status_startTime_idx" ON "AmenityBooking"("amenityId", "status", "startTime");

-- AmenityBooking: resident's upcoming bookings
CREATE INDEX "AmenityBooking_residentId_status_startTime_idx" ON "AmenityBooking"("residentId", "status", "startTime");

-- Complaint: list sorted by date
CREATE INDEX "Complaint_societyId_createdAt_idx" ON "Complaint"("societyId", "createdAt");

-- Parcel: list sorted by date
CREATE INDEX "Parcel_societyId_receivedAt_idx" ON "Parcel"("societyId", "receivedAt");

-- Notice: list sorted by date
CREATE INDEX "Notice_societyId_createdAt_idx" ON "Notice"("societyId", "createdAt");

-- SOSAlert: active SOS filtering
CREATE INDEX "SOSAlert_societyId_status_idx" ON "SOSAlert"("societyId", "status");

-- Poll: active polls filtering
CREATE INDEX "Poll_societyId_status_idx" ON "Poll"("societyId", "status");

-- RefreshToken: password change revocation
CREATE INDEX "RefreshToken_userId_revoked_idx" ON "RefreshToken"("userId", "revoked");

-- MaintenancePayment: dashboard per-villa queries
CREATE INDEX "MaintenancePayment_villaId_month_year_idx" ON "MaintenancePayment"("villaId", "month", "year");
