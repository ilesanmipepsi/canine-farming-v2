-- Mission 07: server-authoritative CFC wallet
-- Apply in Preview only after reviewing the migration plan.
CREATE TABLE IF NOT EXISTS public.cfc_wallets (
  player_id TEXT PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  purchased_balance BIGINT NOT NULL DEFAULT 0 CHECK (purchased_balance >= 0),
  status TEXT NOT NULL DEFAULT 'migration_required'
    CHECK (status IN ('migration_required', 'active', 'restricted')),
  version INTEGER NOT NULL DEFAULT 1,
  daily_jobs_date DATE,
  daily_jobs_count INTEGER NOT NULL DEFAULT 0 CHECK (daily_jobs_count >= 0 AND daily_jobs_count <= 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent additions for environments where the initial table already exists.
ALTER TABLE public.cfc_wallets
  ADD COLUMN IF NOT EXISTS daily_jobs_date DATE;
ALTER TABLE public.cfc_wallets
  ADD COLUMN IF NOT EXISTS daily_jobs_count INTEGER NOT NULL DEFAULT 0;

-- Ensure the same invariant also applies when these columns predate this script.
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cfc_wallets_daily_jobs_count_range'
      AND conrelid = 'public.cfc_wallets'::regclass
  ) THEN
    ALTER TABLE public.cfc_wallets
      ADD CONSTRAINT cfc_wallets_daily_jobs_count_range
      CHECK (daily_jobs_count >= 0 AND daily_jobs_count <= 3) NOT VALID;
  END IF;
END $constraint$;

ALTER TABLE public.cfc_wallets
  VALIDATE CONSTRAINT cfc_wallets_daily_jobs_count_range;

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
