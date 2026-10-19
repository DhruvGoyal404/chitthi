-- migrate:up
-- The role the API runs as. NOLOGIN: in development the API connects with the owner login and
-- switches to this role at connection start (DATABASE_ROLE); in production a dedicated login
-- role is granted membership of it. Roles are cluster-wide, so this is idempotent and the down
-- migration never drops it (other databases on the cluster may hold grants to it).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chitthi_app') THEN
    CREATE ROLE chitthi_app NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO chitthi_app;

-- migrate:down
REVOKE USAGE ON SCHEMA public FROM chitthi_app;
