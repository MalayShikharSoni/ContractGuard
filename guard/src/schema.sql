-- Contract Guard schema. Idempotent so the app can ensure it on every boot.
CREATE TABLE IF NOT EXISTS services (
  id            SERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  owner_team    TEXT NOT NULL,
  owner_contact TEXT,
  description   TEXT,
  current_version_id INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consumers (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  team       TEXT NOT NULL,
  contact    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consumer_usages (
  id          SERIAL PRIMARY KEY,
  consumer_id INTEGER NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  provider_service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  sends       JSONB NOT NULL DEFAULT '[]'::jsonb,
  reads       JSONB NOT NULL DEFAULT '[]'::jsonb,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (consumer_id, provider_service_id, method, path)
);

CREATE TABLE IF NOT EXISTS versions (
  id            SERIAL PRIMARY KEY,
  service_id    INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  version       TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  spec          JSONB NOT NULL,        -- raw parsed document
  flat          JSONB NOT NULL,        -- resolved + flattened wire model (diff input)
  changes       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- diff vs previous published version
  counts        JSONB NOT NULL DEFAULT '{}'::jsonb,
  impact        JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_id    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, version)
);
CREATE INDEX IF NOT EXISTS idx_versions_service ON versions(service_id, revision);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id            SERIAL PRIMARY KEY,
  service_id    INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  attempt_no    INTEGER NOT NULL,
  from_version  TEXT,
  to_version    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('PUBLISHED', 'BLOCKED', 'ERROR')),
  counts        JSONB NOT NULL DEFAULT '{}'::jsonb,
  changes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  impact        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_stage   TEXT,
  error_message TEXT,
  raw           TEXT,                  -- the exact spec that was submitted
  notified      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  attempt_id  INTEGER REFERENCES publish_attempts(id) ON DELETE SET NULL,
  event       TEXT NOT NULL,
  url         TEXT NOT NULL,
  status_code INTEGER,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
