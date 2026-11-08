-- D353: Hire is a one-off purchase. The paid plan appears only after the
-- server has checked the transfer. The browser cannot set the status.

CREATE TABLE IF NOT EXISTS public.plans (
  code text PRIMARY KEY,
  audience text NOT NULL,
  kind text NOT NULL,
  price_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  period text,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT plans_audience_check CHECK (audience IN ('company', 'candidate')),
  CONSTRAINT plans_kind_check CHECK (kind IN ('subscription', 'one_off')),
  CONSTRAINT plans_price_check CHECK (price_minor > 0),
  CONSTRAINT plans_currency_check CHECK (currency = 'USD')
);

CREATE TABLE IF NOT EXISTS public.purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES public.plans(code),
  status text NOT NULL DEFAULT 'pending',
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchases_status_check CHECK (status IN ('pending', 'paid', 'refunded'))
);

CREATE INDEX IF NOT EXISTS purchases_job_paid_idx
  ON public.purchases (job_id)
  WHERE status = 'paid';

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  kind text NOT NULL,
  chain text NOT NULL,
  token text NOT NULL,
  tx_hash text NOT NULL,
  from_address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_kind_check CHECK (kind IN ('charge', 'refund'))
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_chain_tx_idx
  ON public.payments (chain, tx_hash);

CREATE TABLE IF NOT EXISTS public.crypto_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  chain text NOT NULL,
  token text NOT NULL,
  token_contract text NOT NULL,
  recipient text NOT NULL,
  payer_address text NOT NULL,
  amount_minor bigint NOT NULL,
  token_amount text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  reason text,
  tx_hash text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crypto_orders_status_check CHECK (
    status IN ('open', 'submitted', 'confirmed', 'expired', 'frozen', 'failed')
  ),
  CONSTRAINT crypto_orders_token_check CHECK (token IN ('USDC', 'USDT'))
);

CREATE UNIQUE INDEX IF NOT EXISTS crypto_orders_tx_idx
  ON public.crypto_orders (chain, tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.billing_wallet_sessions (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  address text NOT NULL,
  chain_id integer NOT NULL,
  nonce text NOT NULL,
  message text,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS public.billing_interest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  email text,
  plan_code text NOT NULL,
  token text,
  chain text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.plans (code, audience, kind, price_minor, currency, active)
VALUES ('company_hire', 'company', 'one_off', 7900, 'USD', true)
ON CONFLICT (code) DO NOTHING;

SELECT public.enable_rls_deny_all('public.plans');
SELECT public.enable_rls_deny_all('public.purchases');
SELECT public.enable_rls_deny_all('public.payments');
SELECT public.enable_rls_deny_all('public.crypto_orders');
SELECT public.enable_rls_deny_all('public.billing_wallet_sessions');
SELECT public.enable_rls_deny_all('public.billing_interest');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.plans TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchases TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crypto_orders TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_wallet_sessions TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_interest TO app_rw;

-- A payment row is the record of money. The app does not edit or delete it.
REVOKE UPDATE, DELETE ON TABLE public.payments FROM app_rw;
