-- D589 (SEC-20261014-2): a transaction hash is reserved only by the order it
-- confirmed. Before, any order holding the hash (submitted while the transfer
-- was still pending, or failed with a different payer) blocked the real payer.
-- payments_chain_tx_idx stays the guard against counting one transfer twice.
-- Confirmed rows were unique under the old index, so this one builds cleanly.

CREATE UNIQUE INDEX IF NOT EXISTS crypto_orders_confirmed_tx_idx
  ON public.crypto_orders (chain, tx_hash)
  WHERE status = 'confirmed' AND tx_hash IS NOT NULL;

DROP INDEX IF EXISTS public.crypto_orders_tx_idx;
