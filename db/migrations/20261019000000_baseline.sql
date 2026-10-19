-- migrate:up
-- Baseline. Intentionally creates nothing: it marks the start of the migration history so that
-- tooling, CI and the health checks can be exercised before the domain schema
-- (docs/SCHEMA.md) is approved. Domain tables arrive in later migrations.
SELECT 1;

-- migrate:down
SELECT 1;
