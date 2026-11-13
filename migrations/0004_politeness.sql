-- robots.txt cache: fetched at most once per 24 h per origin (plan §4.2 step 1)
CREATE TABLE robots_cache (
  origin      TEXT PRIMARY KEY,          -- 'https://books.toscrape.com'
  status      INTEGER NOT NULL,          -- HTTP status of /robots.txt
  body        TEXT NOT NULL,             -- '' when there is no robots.txt (404)
  fetched_at  TEXT NOT NULL
);

-- Per-run notes: why a page was skipped (robots), why a target failed, etc.
-- JSON array of { target, level, message, url? }
ALTER TABLE runs ADD COLUMN notes TEXT;
