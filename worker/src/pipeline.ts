// fetch → parse → normalize → validate → hash → diff → D1 (plan §4.2)

import type { Env } from "./env";
import { defaultDeps, FetchError, PoliteFetcher, type Deps } from "./fetcher";
import { hashRecord } from "./hash";
import { persistTarget, runBatches, type ValidRecord } from "./persist";
import { TARGETS } from "./targets";
import type { Target } from "./targets/types";

export type Trigger = "cron" | "manual";
export type RunStatus = "ok" | "partial" | "failed";

export interface Note {
  target: string;
  level: "info" | "warn" | "error";
  message: string;
  url?: string;
}

export interface TargetResult {
  target: string;
  ok: boolean;
  pagesFetched: number;
  pagesNotModified: number;
  valid: number;
  invalid: number;
  changes: number;
  snapshots: number;
  removalsChecked: boolean;
}

export interface RunSummary {
  runId: number;
  status: RunStatus;
  pagesFetched: number;
  recordsValid: number;
  recordsInvalid: number;
  changesFound: number;
  targets: TargetResult[];
  notes: Note[];
}

async function scrapeTarget(
  env: Env,
  target: Target,
  runId: number,
  fetcher: PoliteFetcher,
  deps: Deps,
  notes: Note[],
): Promise<TargetResult> {
  const r: TargetResult = {
    target: target.id,
    ok: true,
    pagesFetched: 0,
    pagesNotModified: 0,
    valid: 0,
    invalid: 0,
    changes: 0,
    snapshots: 0,
    removalsChecked: false,
  };
  // we can only say an item disappeared if we actually looked at every page
  let completeView = true;
  const valid: ValidRecord[] = [];
  const errorStmts: D1PreparedStatement[] = [];

  for (const pageUrl of target.pages) {
    let page;
    try {
      page = await fetcher.get(pageUrl);
    } catch (err) {
      r.ok = false;
      completeView = false;
      const msg = err instanceof FetchError ? err.message : String(err);
      notes.push({ target: target.id, level: "error", message: `fetch failed: ${msg}`, url: pageUrl });
      continue;
    }

    if (page.kind === "disallowed") {
      completeView = false;
      notes.push({ target: target.id, level: "warn", message: `skipped: ${page.reason}`, url: pageUrl });
      continue;
    }
    if (page.kind === "not_modified") {
      // 304: nothing on this page changed; cheap skip. We didn't see its items,
      // so removals can't be judged this run.
      r.pagesNotModified++;
      completeView = false;
      notes.push({ target: target.id, level: "info", message: "not modified (304)", url: pageUrl });
      continue;
    }

    r.pagesFetched++;
    const raw = await target.extract(page.html, pageUrl);
    if (raw.length === 0) {
      // 200 but nothing extracted: layout change or malformed HTML. Treat as a
      // failure, not as "every item was removed". Clear the ETag so we re-parse next run.
      r.ok = false;
      completeView = false;
      await fetcher.clearCache(pageUrl);
      notes.push({ target: target.id, level: "error", message: "page parsed to 0 records", url: pageUrl });
      continue;
    }

    for (const rec of raw) {
      const parsed = target.schema.safeParse(rec);
      if (!parsed.success) {
        r.invalid++;
        completeView = false; // an invalid record might be an item that still exists
        errorStmts.push(
          env.DB.prepare(
            `INSERT INTO validation_errors (run_id, target_id, source_url, issues_json, raw_json)
             VALUES (?, ?, ?, ?, ?)`,
          ).bind(runId, target.id, pageUrl, JSON.stringify(parsed.error.issues), JSON.stringify(rec)),
        );
        continue;
      }
      const data = { ...parsed.data, source_url: pageUrl };
      valid.push({ key: target.keyOf(parsed.data), hash: await hashRecord(data), data });
      r.valid++;
    }
  }

  await runBatches(env.DB, errorStmts);

  const persisted = await persistTarget(env.DB, {
    targetId: target.id,
    runId,
    now: deps.now().toISOString(),
    records: valid,
    allowRemovals: completeView,
  });
  r.changes = persisted.changeRows;
  r.snapshots = persisted.snapshots;
  r.removalsChecked = completeView;
  return r;
}

/** Run every target once. Each target is isolated: one broken site can't sink the run. */
export async function runPipeline(
  env: Env,
  trigger: Trigger,
  deps: Deps = defaultDeps,
  targets: Target[] = TARGETS,
): Promise<RunSummary> {
  const started = deps.now().toISOString();
  const run = await env.DB.prepare(
    "INSERT INTO runs (started_at, trigger, status) VALUES (?, ?, 'running') RETURNING id",
  )
    .bind(started, trigger)
    .first<{ id: number }>();
  const runId = run!.id;

  try {
    return await runTargets(env, runId, deps, targets);
  } catch (err) {
    // something outside the per-target isolation broke (e.g. D1 unavailable)
    await env.DB.prepare("UPDATE runs SET finished_at = ?, status = 'failed', notes = ? WHERE id = ?")
      .bind(deps.now().toISOString(), JSON.stringify([{ target: "*", level: "error", message: String(err) }]), runId)
      .run()
      .catch(() => {});
    throw err;
  }
}

async function runTargets(env: Env, runId: number, deps: Deps, targets: Target[]): Promise<RunSummary> {
  const notes: Note[] = [];
  const results: TargetResult[] = [];

  // only scrape targets that are enabled in D1
  const { results: enabledRows } = await env.DB.prepare("SELECT id FROM targets WHERE enabled = 1").all<{
    id: string;
  }>();
  const enabled = new Set(enabledRows.map((t) => t.id));

  const fetcher = new PoliteFetcher(env, deps);
  for (const target of targets) {
    if (!enabled.has(target.id)) continue;
    try {
      results.push(await scrapeTarget(env, target, runId, fetcher, deps, notes));
    } catch (err) {
      console.error(`target ${target.id} failed`, err);
      notes.push({ target: target.id, level: "error", message: `target crashed: ${String(err)}` });
      results.push({
        target: target.id,
        ok: false,
        pagesFetched: 0,
        pagesNotModified: 0,
        valid: 0,
        invalid: 0,
        changes: 0,
        snapshots: 0,
        removalsChecked: false,
      });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  const status: RunStatus =
    results.length > 0 && failed === results.length ? "failed" : failed > 0 ? "partial" : "ok";

  const summary: RunSummary = {
    runId,
    status,
    pagesFetched: sum(results, (r) => r.pagesFetched),
    recordsValid: sum(results, (r) => r.valid),
    recordsInvalid: sum(results, (r) => r.invalid),
    changesFound: sum(results, (r) => r.changes),
    targets: results,
    notes,
  };

  await env.DB.prepare(
    `UPDATE runs SET finished_at = ?, status = ?, pages_fetched = ?, records_valid = ?,
       records_invalid = ?, changes_found = ?, notes = ? WHERE id = ?`,
  )
    .bind(
      deps.now().toISOString(),
      status,
      summary.pagesFetched,
      summary.recordsValid,
      summary.recordsInvalid,
      summary.changesFound,
      notes.length ? JSON.stringify(notes) : null,
      runId,
    )
    .run();

  console.log(
    `run ${runId} ${status}: pages=${summary.pagesFetched} valid=${summary.recordsValid} ` +
      `invalid=${summary.recordsInvalid} changes=${summary.changesFound}`,
  );
  return summary;
}

function sum<T>(xs: T[], f: (x: T) => number): number {
  return xs.reduce((a, x) => a + f(x), 0);
}
