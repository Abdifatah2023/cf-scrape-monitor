# cf-scrape-monitor: Plan

A scheduled Cloudflare Worker scrapes a small set of public pages, validates what it extracts
against strict schemas, saves a new snapshot only when the data has changed, and serves a
dashboard showing what changed and when.

```
Cron Trigger → Worker: fetch → parse → normalize → validate → hash → diff → D1
                                                                         ↓
                                         Pages dashboard ← Pages Functions (read-only API)
```

This is the cloud version of `polite-scraper`. The same pipeline (fetch → extract → normalize →
validate → store → report) runs on a schedule and keeps history.

---

## 1. Scope and targets

Start with sites that are built for scraping practice. You already know their rules, and the
data changes often enough to show up on the dashboard:

| Target | URL | What we track |
|---|---|---|
| Books catalogue (3 pages) | https://books.toscrape.com | title, price, availability, rating |
| Quotes (first page) | https://quotes.toscrape.com | quote text, author, tags |

Optional third target: a public status page or changelog that you're allowed to monitor
(check its robots.txt and terms first).

**Out of scope for v1:** JavaScript-rendered pages (that would need Browser Rendering), logins,
and anything behind a paywall or bot protection.

---

## 2. Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Scheduler | **Cron Triggers** (`scheduled()` handler) | Native. No external cron needed. |
| Language | **TypeScript Worker** + **Zod** | Zod is the closest TypeScript equivalent to Pydantic (parse, coerce, typed errors). Best tooling support on Workers. |
| Alternative | Python Worker + Pydantic | Works, but Python Workers are still maturing and start up slower. Treat it as a stretch goal. |
| HTML parsing | **HTMLRewriter** (built in) | Streaming and very light on CPU, which matters under the Workers free-plan CPU limit. Fallback: `linkedom` for complex selectors. |
| Storage | **D1** (SQLite) | Relational history, easy diffs, and Pages Functions can query it directly. |
| Dashboard | **Cloudflare Pages** + **Pages Functions** | Static UI plus `/api/*` functions bound to the same D1 database (read-only queries). |
| Charts | Chart.js or uPlot (static, no framework) | Small and needs no build step. |

**Project layout (monorepo):**
```
cf-scrape-monitor/
  worker/               # scraper (cron)
    src/index.ts        # scheduled() + manual /run endpoint (protected)
    src/targets/        # one module per target: url(s), extractor, schema
    src/pipeline.ts     # fetch → parse → validate → hash → persist
    src/schemas.ts      # Zod schemas
    wrangler.toml
  dashboard/            # Pages project
    public/             # index.html, target.html, app.js, styles.css
    functions/api/      # targets.ts, runs.ts, changes.ts, history.ts
    wrangler.toml
  migrations/           # D1 SQL migrations (shared)
  test/
```

---

## 3. Data model (D1)

```sql
-- migrations/0001_init.sql
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
```

---

## 4. The scraper Worker

### 4.1 Schedule
```toml
# worker/wrangler.toml
name = "scrape-monitor"
main = "src/index.ts"
compatibility_date = "2026-11-01"

[triggers]
crons = ["17 */6 * * *"]     # every 6 h, at an odd minute to avoid the top-of-hour rush

[[d1_databases]]
binding = "DB"
database_name = "scrape-monitor"
database_id = "<from wrangler d1 create>"
migrations_dir = "../migrations"

[vars]
USER_AGENT = "cf-scrape-monitor/0.1 (+https://<your-pages-domain>/about)"
```

### 4.2 Pipeline (per target)
1. **robots.txt check.** Fetch it and cache the result for 24 h. Skip any disallowed path and
   record why.
2. **Fetch politely.** Requests go out one at a time per host, with a small delay between them.
   Send `If-None-Match` / `If-Modified-Since` using `fetch_cache`. A `304` means "unchanged"
   and the page is skipped cheaply. Use a timeout via `AbortSignal.timeout(10_000)` and retry
   once with backoff on 5xx or 429 (and respect `Retry-After`).
3. **Parse.** Use HTMLRewriter selectors to build raw records (all strings).
4. **Normalize and validate.** A Zod schema per target, for example:
   ```ts
   export const Book = z.object({
     url: z.string().url(),
     title: z.string().trim().min(1),
     price: z.string().transform(s => Number(s.replace(/[^0-9.]/g, ""))).pipe(z.number().positive()),
     in_stock: z.string().transform(s => /in stock/i.test(s)),
     rating: z.enum(["One","Two","Three","Four","Five"]).transform(r => ["One","Two","Three","Four","Five"].indexOf(r) + 1),
   }).strict();
   ```
   Use `safeParse`. Invalid records go to `validation_errors`, and the run continues.
5. **Hash.** SHA-256 (`crypto.subtle`) over canonical JSON (sorted keys, provenance fields
   excluded).
6. **Diff and persist.** Compare against `items.current_hash`:
   - new key → `items` + `snapshots` + `changes(kind='added')`
   - hash differs → `snapshots` + one `changes` row per changed field
   - key seen before but missing this run → `changes(kind='removed')`, but **only if the page
     fetched successfully**. This keeps a failed fetch from showing up as a mass deletion.
   - Write in batches with `env.DB.batch([...])` to keep the number of round trips low.
7. **Finalize the run.** Update the `runs` row with counts and status
   (`partial` if any target failed).

Each target runs inside its own `try/catch`, so one broken site can't take down the whole run.
Use `ctx.waitUntil()` for any work that can finish after the handler returns.

### 4.3 Manual trigger
Add a `POST /run` endpoint protected by a secret (`wrangler secret put RUN_TOKEN`) so you can
start a scrape on demand from the dashboard or with curl.

### 4.4 Platform limits to design around
- **Subrequests per invocation:** 50 on the free plan, much higher on paid. 3 book pages +
  robots.txt checks + quotes fits easily. If you add per-book detail pages (60+), either switch
  to Workers Paid or split targets across several cron schedules (one target per cron,
  dispatching on `event.cron`).
- **CPU time:** waiting on the network doesn't count, but parsing does. HTMLRewriter keeps
  parsing cheap.
- **D1:** keep writes batched. Add a retention job (e.g. delete snapshots older than 90 days,
  keeping the latest one per item).

---

## 5. Dashboard (Pages)

**Pages Functions (read-only API, bound to the same D1 database):**

| Endpoint | Returns |
|---|---|
| `GET /api/summary` | last run, status, totals, changes in the last 24 h / 7 d |
| `GET /api/runs?limit=50` | run history (for the health chart) |
| `GET /api/changes?target=&field=&since=` | change feed, paginated |
| `GET /api/items/:id/history` | snapshots over time (e.g. price line chart) |
| `GET /api/errors?run=` | validation failures with Zod issues |

**Views:**
1. **Overview.** Stat tiles (last run, success rate, items tracked, changes this week), a
   runs-over-time bar chart colored by status, and the latest changes.
2. **Change feed.** A filterable table: time, target, item, field, old → new.
3. **Item detail.** A price/field history line chart and a snapshot timeline.
4. **Data quality.** Validation errors grouped by target and issue, plus the most recent failing
   URLs.

Cache API responses briefly (`Cache-Control: max-age=60`). For v1, put the dashboard behind
**Cloudflare Access**, or keep it public since it only reads data. Don't expose `/run` without
the token.

---

## 6. Milestones

| # | Milestone | Done when |
|---|---|---|
| 0 | Setup | `wrangler login`; `wrangler d1 create scrape-monitor`; migrations applied locally and remotely |
| 1 | Single target, local | `wrangler dev --test-scheduled` + `curl "localhost:8787/__scheduled?cron=17+*/6+*+*+*"` writes books to local D1 |
| 2 | Validation | Zod schemas, `validation_errors` populated by a deliberately broken fixture |
| 3 | Change detection | Hashing + diffing, so a second run with unchanged data writes 0 snapshots and a modified fixture writes the correct `changes` rows |
| 4 | Politeness | robots.txt, conditional requests, delay between requests, retry/backoff, User-Agent |
| 5 | Deploy scraper | `wrangler deploy`; cron visible in the dashboard; first real runs in remote D1 |
| 6 | Dashboard API | Pages Functions with D1 binding; endpoints return JSON |
| 7 | Dashboard UI | Overview, change feed, item history chart, data-quality view |
| 8 | Second target + hardening | quotes target, per-target isolation, retention job, alerting (optional: email or webhook when changes exceed a threshold or a run fails) |
| 9 | Docs | README with architecture diagram, target classification (same format as polite-scraper), screenshots |

---

## 7. Testing

- **Unit tests** (Vitest + `@cloudflare/vitest-pool-workers`): extractors against saved HTML
  fixtures in `test/fixtures/`, Zod schemas (good and bad records), canonical hashing, and
  field diffs.
- **Integration tests:** run the pipeline against a local D1 with mocked `fetch` (via
  `fetchMock`). Assert the number of rows in `runs`, `items`, `snapshots`, and `changes` over
  two runs, one with changed fixtures.
- **Failure cases:** 500 response, timeout, 304, malformed HTML, robots.txt disallow, and the
  "fetch failed, so don't mark items removed" rule.
- **Smoke test after deploy:** call `POST /run` with the token, then check `/api/summary`.

---

## 8. Ethics and politeness checklist

- [ ] Only scrape targets whose robots.txt and terms allow it, and document this per target
- [ ] Use an identifying User-Agent with a contact or about URL
- [ ] Scrape no more often than every 6 h, send requests one at a time, use conditional requests
- [ ] Collect no personal data
- [ ] Back off on 429/503 and respect `Retry-After`

---

## 9. Stretch ideas
- Store raw HTML in **R2** for replay and debugging (re-parse old pages after fixing an
  extractor)
- **Queues** to fan out page fetches when targets grow beyond one invocation's limits
- **Browser Rendering** for JS-heavy pages
- Python Worker port using real Pydantic for comparison
- Workers AI summary of each day's changes
