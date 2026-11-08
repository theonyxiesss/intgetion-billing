-- D380: crypto addresses from the open OFAC SDN list. A daily cron replaces
-- the set. Before a transfer is counted, the sender is checked here; a match
-- freezes the order and no plan is granted.

CREATE TABLE IF NOT EXISTS public.sanctioned_addresses (
  address text PRIMARY KEY,
  currency text NOT NULL,
  source text NOT NULL DEFAULT 'ofac_sdn',
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- EVM addresses are stored lower-case so the check is a plain equality.
  CONSTRAINT sanctioned_addresses_evm_lower_check
    CHECK (address NOT LIKE '0x%' OR address = lower(address)),
  CONSTRAINT sanctioned_addresses_source_check CHECK (source IN ('ofac_sdn'))
);

SELECT public.enable_rls_deny_all('public.sanctioned_addresses');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sanctioned_addresses TO app_rw;
