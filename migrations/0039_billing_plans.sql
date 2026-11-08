-- D358: Team, Plus and Pro are one 30-day payment each. The charge is the
-- monthly price. Nothing renews by itself. Hire still needs a job.

ALTER TABLE public.purchases ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE public.purchases ALTER COLUMN job_id DROP NOT NULL;

ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.purchases DROP CONSTRAINT IF EXISTS purchases_subject_check;
ALTER TABLE public.purchases
  ADD CONSTRAINT purchases_subject_check
  CHECK (company_id IS NOT NULL OR user_id IS NOT NULL);

-- plans has FORCE ROW LEVEL SECURITY. The migration role is not app_rw,
-- so the insert is allowed only while force is off. The owner bypasses then.
ALTER TABLE public.plans NO FORCE ROW LEVEL SECURITY;

INSERT INTO public.plans (code, audience, kind, price_minor, currency, period, active)
VALUES
  ('company_team', 'company', 'subscription', 19900, 'USD', 'month', true),
  ('candidate_plus', 'candidate', 'subscription', 500, 'USD', 'month', true),
  ('candidate_pro', 'candidate', 'subscription', 1500, 'USD', 'month', true)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.plans FORCE ROW LEVEL SECURITY;
