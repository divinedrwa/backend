import { Router } from "express";
import authRoutes from "../modules/auth/routes";
import legalRoutes from "../modules/legal/routes";
import publicRoutes from "../modules/public/routes";
import superRoutes from "../modules/super/routes";
import {
  applyRateLimitIfEnabled,
  authLimiter,
  bulkLimiter,
  publicLimiter,
  superAdminLimiter,
} from "../middlewares/rateLimiter";
import userRoutes from "../modules/users/routes";
import residentManagementRoutes from "../modules/resident-management/routes";
import villaRoutes from "../modules/villas/routes";
import maintenancePaymentRoutes from "../modules/maintenance-payments/routes";
import maintenanceRoutes from "../modules/maintenance/routes";
import maintenanceManagementRoutes from "../modules/maintenance-management/routes";
import bankAccountRoutes from "../modules/bank-accounts/routes";
import sosAlertRoutes from "../modules/sos-alerts/routes";
import waterSupplyRoutes from "../modules/water-supply/routes";
import waterSupplyAnalyticsRoutes from "../modules/water-supply-analytics/routes";
import garbageCollectionRoutes from "../modules/garbage-collection/routes";
import complaintRoutes from "../modules/complaints/routes";
import complaintAnalyticsRoutes from "../modules/complaint-analytics/routes";
import vendorRoutes from "../modules/vendors/routes";
import noticeRoutes from "../modules/notices/routes";
import visitorRoutes from "../modules/visitors/routes";
import parcelRoutes from "../modules/parcels/routes";
import gateRoutes from "../modules/gates/routes";
import gateAnalyticsRoutes from "../modules/gate-analytics/routes";
import guardShiftRoutes from "../modules/guard-shifts/routes";
import guardPatrolRoutes from "../modules/guard-patrols/routes";
import amenityRoutes from "../modules/amenities/routes";
import amenityBookingRoutes from "../modules/amenity-bookings/routes";
import amenityBookingCalendarRoutes from "../modules/amenity-booking-calendar/routes";
import staffRoutes from "../modules/staff/routes";
import staffAssignmentOverviewRoutes from "../modules/staff-assignment-overview/routes";
import vehicleRoutes from "../modules/vehicles/routes";
import parkingManagementRoutes from "../modules/parking-management/routes";
import preApprovedVisitorRoutes from "../modules/pre-approved-visitors/routes";
import pollRoutes from "../modules/polls/routes";
import documentRoutes from "../modules/documents/routes";
import incidentRoutes from "../modules/incidents/routes";
import bannerRoutes from "../modules/banners/routes";
import expenseRoutes from "../modules/expenses/routes";
import notificationRoutes from "../modules/notifications/routes";
import billingV1Routes from "../modules/billing-cycle/billing-v1.routes";
import societySettingsRoutes from "../modules/society-settings/routes";
import invitationRoutes from "../modules/invitations/routes";
import importRoutes from "../modules/import/routes";
import exportRoutes from "../modules/export/routes";
import reconciliationRoutes from "../modules/reconciliation/routes";
import adminOpsRoutes from "../modules/admin-ops/system-health.routes";
import upiPaymentAdminRoutes from "../modules/upi-payments/admin-routes";
import upiPaymentResidentRoutes from "../modules/upi-payments/resident-routes";
import specialProjectRoutes from "../modules/special-projects/routes";
import paymentDisputeRoutes from "../modules/payment-disputes/routes";
import paymentMethodRoutes, { residentPaymentMethodsRouter } from "../modules/payment-methods/routes";
import auditLogRoutes from "../modules/audit-log/routes";
import vendorContractRoutes from "../modules/vendor-contracts/routes";
import assetRoutes from "../modules/assets/routes";
import meetingRoutes from "../modules/meetings/routes";
import staffAttendanceRoutes from "../modules/staff-attendance/routes";
import appAnalyticsRoutes from "../modules/app-analytics/routes";

// NEW: Resident Mobile APIs
import residentRoutes from "../modules/residents/routes";
import residentMaintenanceRoutes from "../modules/residents/maintenance";
import residentVisitorRoutes from "../modules/residents/visitors";
import residentParcelRoutes from "../modules/residents/parcels";
import residentComplaintRoutes from "../modules/residents/complaints";
import residentAmenityRoutes from "../modules/residents/amenities";
import residentVehicleRoutes from "../modules/residents/vehicles";
import residentStaffRoutes from "../modules/residents/staff";
import residentExpenseRoutes from "../modules/residents/expenses";
import residentSpecialProjectRoutes from "../modules/residents/special-projects";
import residentPaymentDisputeRoutes from "../modules/residents/payment-disputes";
import residentWaterRequestRoutes from "../modules/residents/water-requests";

// NEW: Guard Mobile APIs
import guardRoutes from "../modules/guards/routes";
import guardVisitorRoutes from "../modules/guards/visitors";
import guardParcelRoutes from "../modules/guards/parcels";
import guardPatrolsRoutes from "../modules/guards/patrols";
import guardOperationsRoutes from "../modules/guards/operations";

const router = Router();

// Auth & public — specialized rate limits on top of global apiLimiter
router.use("/public", applyRateLimitIfEnabled(publicLimiter), publicRoutes);
router.use("/auth", applyRateLimitIfEnabled(authLimiter), authRoutes);
router.use("/super", applyRateLimitIfEnabled(superAdminLimiter), superRoutes);
router.use("/legal", legalRoutes);
router.use("/users", userRoutes);
router.use("/resident-management", residentManagementRoutes);
router.use("/villas", villaRoutes);
router.use("/import", applyRateLimitIfEnabled(bulkLimiter), importRoutes);
router.use("/export", applyRateLimitIfEnabled(bulkLimiter), exportRoutes);

// Maintenance & Billing (NEW SYSTEM)
router.use("/maintenance", maintenancePaymentRoutes);
router.use("/maintenance-bills", maintenanceRoutes);
router.use("/maintenance-management", maintenanceManagementRoutes);
router.use("/bank-accounts", bankAccountRoutes);

// Emergency & Guard Operations (NEW)
router.use("/sos-alerts", sosAlertRoutes);
router.use("/water-supply", waterSupplyRoutes);
router.use("/water-supply-analytics", waterSupplyAnalyticsRoutes);
router.use("/garbage-collection", garbageCollectionRoutes);

// Complaints & Vendors
router.use("/complaints", complaintRoutes);
router.use("/payment-disputes", paymentDisputeRoutes);
router.use("/complaint-analytics", complaintAnalyticsRoutes);
router.use("/app-analytics", appAnalyticsRoutes);
router.use("/vendors", vendorRoutes);

// Communication
router.use("/notices", noticeRoutes);

// Security & Gate Management
router.use("/gates", gateRoutes);
router.use("/gate-analytics", gateAnalyticsRoutes);
router.use("/guard-shifts", guardShiftRoutes);
router.use("/guard-patrols", guardPatrolRoutes);
router.use("/visitors", visitorRoutes);
router.use("/pre-approved-visitors", preApprovedVisitorRoutes);
router.use("/parcels", parcelRoutes);
router.use("/incidents", incidentRoutes);

// Amenities
router.use("/amenities", amenityRoutes);
router.use("/amenity-bookings", amenityBookingRoutes);
router.use("/amenity-booking-calendar", amenityBookingCalendarRoutes);

// Resident Services
router.use("/staff", staffRoutes);
router.use("/staff-assignment-overview", staffAssignmentOverviewRoutes);
router.use("/vehicles", vehicleRoutes);
router.use("/parking-management", parkingManagementRoutes);

// Governance
router.use("/polls", pollRoutes);
router.use("/documents", documentRoutes);

// Banners & Events (Mobile App Carousel)
router.use("/banners", bannerRoutes);

// Monthly Expenses Management
router.use("/expenses", expenseRoutes);

// Push & in-app notifications
router.use("/notifications", notificationRoutes);

/** Society-level config (admin): gate visitor rules, lifecycle status, invitations. */
router.use("/society-settings", societySettingsRoutes);

/** Invite tokens (includes unauthenticated GET /invitations/verify/:token). */
router.use("/invitations", invitationRoutes);

/** Maintenance billing cycles (v1 API — server-side status + payments). */
router.use("/v1", billingV1Routes);

/** Financial reconciliation & monitoring (admin only). */
router.use("/reconciliation", reconciliationRoutes);

/** Admin ops: system health (F1). */
router.use("/admin-ops", adminOpsRoutes);

/** UPI payment submissions (admin verify/reject). */
router.use("/upi-payments", upiPaymentAdminRoutes);

/** Special Projects & Collections (admin). */
router.use("/special-projects", specialProjectRoutes);

/** Unified payment methods (admin CRUD + test-connection). */
router.use("/payment-methods", paymentMethodRoutes);

/** Admin audit log viewer. */
router.use("/audit-log", auditLogRoutes);

/** Vendor contracts (admin CRUD). */
router.use("/vendor-contracts", vendorContractRoutes);

/** Society asset inventory (admin CRUD). */
router.use("/assets", assetRoutes);

/** Meetings & AGM management. */
router.use("/meetings", meetingRoutes);

/** Domestic staff attendance tracking. */
router.use("/staff-attendance", staffAttendanceRoutes);

// ========================================
// MOBILE APP APIs (NEW)
// ========================================

// Resident Mobile APIs
router.use("/residents", residentRoutes); // Profile, villa, family, emergency contacts
router.use("/residents", residentMaintenanceRoutes); // Maintenance payments
router.use("/residents", upiPaymentResidentRoutes); // UPI payment submissions
router.use("/residents", residentVisitorRoutes); // Visitors, pre-approval
router.use("/residents", residentParcelRoutes); // Parcels
router.use("/residents", residentComplaintRoutes); // Complaints
router.use("/residents", residentAmenityRoutes); // Amenity bookings
router.use("/residents", residentVehicleRoutes); // Vehicles
router.use("/residents", residentStaffRoutes); // Domestic staff
router.use("/residents", residentExpenseRoutes); // Society expenses (read-only)
router.use("/residents", residentSpecialProjectRoutes); // Special projects
router.use("/residents", residentPaymentDisputeRoutes); // Payment disputes (G5)
router.use("/residents", residentWaterRequestRoutes); // Water supply requests
router.use("/residents", residentPaymentMethodsRouter); // Payment methods

// Guard Mobile APIs
router.use("/guards", guardRoutes); // Dashboard, shift, SOS
router.use("/guards", guardVisitorRoutes); // Check-in/out
router.use("/guards", guardParcelRoutes); // Parcel logging
router.use("/guards", guardPatrolsRoutes); // Patrols, legacy create-incident
router.use("/guards", guardOperationsRoutes); // Vehicle ledger, SOC, directory, incidents, approved vehicles

export default router;
