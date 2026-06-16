-- Phase 6 follow-up: store finding category (for trend top-categories) and
-- the role of a feedback actor (for role-aware suppression). Both additive
-- and nullable; existing rows keep NULL and new writes populate them.

ALTER TABLE "findings" ADD COLUMN "category" TEXT;
ALTER TABLE "finding_feedback" ADD COLUMN "role" TEXT;
