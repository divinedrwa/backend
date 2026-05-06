-- Phase 1: new enums + extend existing enums (committed before using new labels on columns).
-- PostgreSQL forbids using a newly added enum value in the same transaction that adds it.

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('ANDROID', 'IOS', 'WEB');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('SYSTEM', 'BROADCAST', 'SOS', 'NOTICE', 'VISITOR', 'PAYMENT', 'COMPLAINT', 'PARCEL', 'AMENITY', 'POLL', 'WATER_SUPPLY', 'GARBAGE', 'MAINTENANCE', 'EXPENSE', 'OTHER');

-- CreateEnum
CREATE TYPE "BillingCycleStatus" AS ENUM ('UPCOMING', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "BillingUserPaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingPaymentSource" AS ENUM ('GATEWAY', 'CASH_MANUAL');

-- CreateEnum
CREATE TYPE "NoticeCategory" AS ENUM ('GENERAL', 'MAINTENANCE', 'EVENT', 'EMERGENCY', 'ANNOUNCEMENT', 'MEETING');

-- CreateEnum
CREATE TYPE "NoticePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "VisitorVillaApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BannerType" AS ENUM ('EVENT', 'ANNOUNCEMENT', 'FESTIVAL', 'EMERGENCY', 'MAINTENANCE', 'OFFER', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "GateVehicleKind" AS ENUM ('RESIDENT', 'VISITOR');

-- CreateEnum
CREATE TYPE "SocBroadcastKind" AS ENUM ('FIRE', 'MEDICAL', 'SECURITY');

-- AlterEnum
ALTER TYPE "ParcelStatus" ADD VALUE 'RECEIVED';
ALTER TYPE "ParcelStatus" ADD VALUE 'DELIVERED';

-- AlterEnum
ALTER TYPE "SOSStatus" ADD VALUE 'CREATED';
ALTER TYPE "SOSStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "SOSStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "SOSStatus" ADD VALUE 'PENDING';

-- AlterEnum
ALTER TYPE "SOSType" ADD VALUE 'SECURITY';

-- AlterEnum
ALTER TYPE "VendorCategory" ADD VALUE 'PAINTER';
