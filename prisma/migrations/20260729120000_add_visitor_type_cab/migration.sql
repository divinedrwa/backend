-- Add CAB to VisitorType for rideshare / taxi pickup-drop pre-approvals.
ALTER TYPE "VisitorType" ADD VALUE IF NOT EXISTS 'CAB';
