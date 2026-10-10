-- ClentVix migration 001: per-user data model (replaces the shared 'default-workspace' design).
-- Idempotent and additive: safe on a fresh database AND on the existing Neon database.
-- It never drops tables or deletes rows. Legacy rows (workspace_id = 'default-workspace',
-- user_id IS NULL) are left untouched but are unreachable by the application, because every
-- query filters on user_id = <authenticated Google account id>.

CREATE TABLE IF NOT EXISTS clentvix_prospects (
  id                  text PRIMARY KEY,
  user_id             text,
  name                text NOT NULL,
  domain              text NOT NULL DEFAULT '',
  website_url         text NOT NULL DEFAULT '',
  category            text NOT NULL DEFAULT 'Unknown',
  location            text NOT NULL DEFAULT 'Unknown',
  score               integer,
  priority            text,
  stage               text NOT NULL DEFAULT 'New',
  reason              text NOT NULL DEFAULT '',
  evidence            text NOT NULL DEFAULT '',
  next_action         text NOT NULL DEFAULT '',
  source_provider     text NOT NULL DEFAULT 'unknown',
  verification_status text NOT NULL DEFAULT 'unverified',
  is_demo             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Columns added for real discovery / evidence / per-user ownership.
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS user_id            text;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS saved              boolean NOT NULL DEFAULT false;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS address            text;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS source_url         text;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS provider_place_id  text;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS dedupe_key         text;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS evidence_items     jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS analysis_status    text NOT NULL DEFAULT 'pending';
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS analysis_error     text;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS analyzed_at        timestamptz;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS ai_model           text;
ALTER TABLE clentvix_prospects ADD COLUMN IF NOT EXISTS discovery_id       text;

-- Unscored prospects (not yet analysed) must be representable honestly instead of "0 / Low".
ALTER TABLE clentvix_prospects ALTER COLUMN score    DROP NOT NULL;
ALTER TABLE clentvix_prospects ALTER COLUMN priority DROP NOT NULL;
ALTER TABLE clentvix_prospects ALTER COLUMN score    DROP DEFAULT;
ALTER TABLE clentvix_prospects ALTER COLUMN priority DROP DEFAULT;

-- Legacy shared-workspace column: keep it (no data loss) but stop requiring it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'clentvix_prospects' AND column_name = 'workspace_id'
  ) THEN
    ALTER TABLE clentvix_prospects ALTER COLUMN workspace_id DROP NOT NULL;
  END IF;
END $$;

-- Every NEW or UPDATED row must belong to a user. NOT VALID = enforced going forward without
-- failing on legacy rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clentvix_prospects_user_required') THEN
    ALTER TABLE clentvix_prospects
      ADD CONSTRAINT clentvix_prospects_user_required CHECK (user_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

-- Deduplication per user (NULL user_id legacy rows never collide because NULLs are distinct).
CREATE UNIQUE INDEX IF NOT EXISTS clentvix_prospects_user_dedupe_uidx ON clentvix_prospects (user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS clentvix_prospects_user_score_idx ON clentvix_prospects (user_id, score DESC NULLS LAST, created_at DESC);

CREATE TABLE IF NOT EXISTS clentvix_user_settings (
  user_id              text PRIMARY KEY,
  service_name         text NOT NULL DEFAULT '',
  value_proposition    text NOT NULL DEFAULT '',
  default_business_type text NOT NULL DEFAULT '',
  default_location     text NOT NULL DEFAULT '',
  notifications_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clentvix_discoveries (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  business_type  text NOT NULL,
  location       text NOT NULL,
  focus          text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'running',
  found_count    integer NOT NULL DEFAULT 0,
  new_count      integer NOT NULL DEFAULT 0,
  analyzed_count integer NOT NULL DEFAULT 0,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS clentvix_discoveries_user_idx ON clentvix_discoveries (user_id, created_at DESC);
