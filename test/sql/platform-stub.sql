-- Minimal platform tables billing reads. CI only; the real ones belong to the platform.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid uuid UNIQUE,
  terms_accepted_at timestamptz,
  terms_version text
);

CREATE TABLE IF NOT EXISTS public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.company_members (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  source text NOT NULL DEFAULT 'direct',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Same helper as platform migration 0001.
CREATE OR REPLACE FUNCTION public.enable_rls_deny_all(target regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  short_name text;
BEGIN
  SELECT c.relname INTO short_name FROM pg_class c WHERE c.oid = target;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', target);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO anon, authenticated, app_rw',
    target
  );
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', short_name || '_app_rw_all', target);
  EXECUTE format(
    'CREATE POLICY %I ON %s FOR ALL TO app_rw USING (true) WITH CHECK (true)',
    short_name || '_app_rw_all',
    target
  );
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', short_name || '_anon_deny', target);
  EXECUTE format(
    'CREATE POLICY %I ON %s FOR ALL TO anon USING (false) WITH CHECK (false)',
    short_name || '_anon_deny',
    target
  );
  EXECUTE format(
    'DROP POLICY IF EXISTS %I ON %s',
    short_name || '_authenticated_deny',
    target
  );
  EXECUTE format(
    'CREATE POLICY %I ON %s FOR ALL TO authenticated USING (false) WITH CHECK (false)',
    short_name || '_authenticated_deny',
    target
  );
END;
$$;
