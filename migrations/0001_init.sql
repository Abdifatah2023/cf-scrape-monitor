CREATE TABLE targets (
  id          TEXT PRIMARY KEY,          -- 'books', 'quotes'
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  trigger       TEXT NOT NULL,           -- 'cron' | 'manual'
  status        TEXT NOT NULL,           -- 'ok' | 'partial' | 'failed'
  pages_fetched INTEGER DEFAULT 0,
  records_valid INTEGER DEFAULT 0,
  records_invalid INTEGER DEFAULT 0,
  changes_found INTEGER DEFAULT 0
);

-- One row per tracked item (e.g. one book), keyed by a stable natural key
CREATE TABLE items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id   TEXT NOT NULL REFERENCES targets(id),
  item_key    TEXT NOT NULL,             -- e.g. product URL
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  UNIQUE (target_id, item_key)
);

-- Append-only: a snapshot is written ONLY when the hash differs
CREATE TABLE snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  hash        TEXT NOT NULL,
  data_json   TEXT NOT NULL,             -- validated, normalized record
  captured_at TEXT NOT NULL
);

-- Field-level changes, precomputed so the dashboard does not need to diff JSON
CREATE TABLE changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  kind        TEXT NOT NULL,             -- 'added' | 'updated' | 'removed'
  field       TEXT,                      -- e.g. 'price'
  old_value   TEXT,
  new_value   TEXT,
  detected_at TEXT NOT NULL
);

CREATE TABLE validation_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  target_id   TEXT NOT NULL,
  source_url  TEXT NOT NULL,
  issues_json TEXT NOT NULL,             -- Zod error.issues
  raw_json    TEXT                       -- the raw extracted record
);

-- HTTP caching state for polite conditional requests
CREATE TABLE fetch_cache (
  url           TEXT PRIMARY KEY,
  etag          TEXT,
  last_modified TEXT,
  last_status   INTEGER,
  fetched_at    TEXT
);

CREATE INDEX idx_changes_detected ON changes(detected_at DESC);
CREATE INDEX idx_snapshots_item   ON snapshots(item_id, captured_at DESC);