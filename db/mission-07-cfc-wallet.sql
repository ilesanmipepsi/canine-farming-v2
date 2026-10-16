-- Mission 07: server-authoritative CFC wallet
-- Run against the project's Neon database before enabling economy API routes.
CREATE TABLE IF NOT EXISTS public.cfc_wallets (
  player_id TEXT PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  purchased_balance BIGINT NOT NULL DEFAULT 0 CHECK (purchased_balance >= 0),
  status TEXT NOT NULL DEFAULT 'migration_required'
    CHECK (status IN ('migration_required', 'active', 'restricted')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cfc_transactions (
  id BIGSERIAL PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES public.cfc_wallets(player_id),
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount <> 0),
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS cfc_transactions_player_created_idx
  ON public.cfc_transactions (player_id, created_at DESC);

-- Never seed balances from client-submitted localStorage values.
-- Existing players remain migration_required until a reviewed migration maps
-- their legacy save to a verified Vatar player and reconciles earned/purchased CFC.
