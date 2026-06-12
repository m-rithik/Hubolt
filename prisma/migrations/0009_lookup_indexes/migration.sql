-- Webhook deliveries look repositories up by fullName alone; the composite
-- unique (orgId, fullName) cannot serve that lookup.
CREATE INDEX "repositories_fullName_idx" ON "repositories"("fullName");

-- Audit export filters by orgId with a createdAt range and order; the
-- composite index serves the query directly.
CREATE INDEX "audit_events_orgId_createdAt_idx" ON "audit_events"("orgId", "createdAt");
