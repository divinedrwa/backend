import { Router } from "express";
import authRoutes from "../modules/auth/routes";
import publicRoutes from "../modules/public/routes";
import superRoutes from "../modules/super/routes";
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

// NEW: Resident Mobile APIs
import residentRoutes from "../modules/residents/routes";
import residentMaintenanceRoutes from "../modules/residents/maintenance";
import residentVisitorRoutes from "../modules/residents/visitors";
import residentParcelRoutes from "../modules/residents/parcels";
import residentComplaintRoutes from "../modules/residents/complaints";
import residentAmenityRoutes from "../modules/residents/amenities";
import residentVehicleRoutes from "../modules/residents/vehicles";
import residentStaffRoutes from "../modules/residents/staff";

// NEW: Guard Mobile APIs
import guardRoutes from "../modules/guards/routes";
import guardVisitorRoutes from "../modules/guards/visitors";
import guardParcelRoutes from "../modules/guards/parcels";
import guardPatrolsRoutes from "../modules/guards/patrols";
import guardOperationsRoutes from "../modules/guards/operations";

const router = Router();

// Auth & public
router.use("/public", publicRoutes);
router.use("/auth", authRoutes);
router.use("/super", superRoutes);
router.use("/users", userRoutes);
router.use("/resident-management", residentManagementRoutes);
router.use("/villas", villaRoutes);
router.use("/import", importRoutes);
router.use("/export", exportRoutes);

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
router.use("/complaint-analytics", complaintAnalyticsRoutes);
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

// ========================================
// MOBILE APP APIs (NEW)
// ========================================

// Resident Mobile APIs
router.use("/residents", residentRoutes); // Profile, villa, family, emergency contacts
router.use("/residents", residentMaintenanceRoutes); // Maintenance payments
router.use("/residents", residentVisitorRoutes); // Visitors, pre-approval
router.use("/residents", residentParcelRoutes); // Parcels
router.use("/residents", residentComplaintRoutes); // Complaints
router.use("/residents", residentAmenityRoutes); // Amenity bookings
router.use("/residents", residentVehicleRoutes); // Vehicles
router.use("/residents", residentStaffRoutes); // Domestic staff

// Guard Mobile APIs
router.use("/guards", guardRoutes); // Dashboard, shift, SOS
router.use("/guards", guardVisitorRoutes); // Check-in/out
router.use("/guards", guardParcelRoutes); // Parcel logging
router.use("/guards", guardPatrolsRoutes); // Patrols, legacy create-incident
router.use("/guards", guardOperationsRoutes); // Vehicle ledger, SOC, directory, incidents

export default router;
