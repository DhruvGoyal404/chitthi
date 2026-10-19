-- migrate:up
-- The API's login role, in every environment: LOGIN, a member of chitthi_app (whose grants it
-- inherits), and nothing else (no superuser, createdb, createrole, replication or bypassrls).
-- The owner role is only for migrations and tests. The password is never in a migration:
-- `npm run db:api-password` sets it from DATABASE_URL (dev, CI); production sets it in the
-- platform's secret store. Roles are cluster-wide, so this is idempotent and never undone.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chitthi_api') THEN
    CREATE ROLE chitthi_api LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
GRANT chitthi_app TO chitthi_api;

-- migrate:down
-- Intentionally empty: role membership is cluster-wide, and revoking it here would cut off
-- every other database on the cluster that the API (or a test run) is using.
SELECT 1;
