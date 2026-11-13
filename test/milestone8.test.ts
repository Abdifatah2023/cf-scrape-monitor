import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { alertReasons, maybeAlert } from "../worker/src/alert";
import worker, { CRON_RETENTION } from "../worker/src/index";
import { runPipeline, type RunSummary } from "../worker/src/pipeline";
import { runRetention } from "../worker/src/retention";
import { count, fakeNet, PAGE, resetDb } from "./helpers";

import quotesPage from "./fixtures/quotes-page-1.html?raw";

const QUOTES = "https://quotes.toscrape.com";

function bothTargets() {
  const net = fakeNet();
  net.route(`${QUOTES}/robots.txt`, () => new Response("", { status: 404 }));
  net.route(`${QUOTES}/`, quotesPage);
  return net;
}

beforeEach(resetDb);

describe("second target: quotes", () => {
  it("scrapes books and quotes in one run", async () => {
    const s = await runPipeline(env, "cron", bothTargets().deps);
    expect(s.status).toBe("ok");
    expect(s.targets.map((t) => t.target)).toEqual(["books", "quotes"]);
    expect(await count("items", "target_id = 'books'")).toBe(60);
    expect(await count("items", "target_id = 'quotes'")).toBe(10);
  });

  it("detects a tag change on a quote", async () => {
    await runPipeline(env, "cron", bothTargets().deps);
    const net = bothTargets();
    net.route(`${QUOTES}/`, quotesPage.replace('<a class="tag" href="/tag/world/page/1/">world</a>', ""));
    const s = await runPipeline(env, "cron", net.deps);
    const { results } = await env.DB.prepare("SELECT field, old_value, new_value FROM changes WHERE run_id = ?").bind(s.runId).all();
    expect(results).toEqual([
      { field: "tags", old_value: '["change","deep-thoughts","thinking","world"]', new_value: '["change","deep-thoughts","thinking"]' },
    ]);
  });

  it("disabled targets (targets.enabled = 0) are skipped", async () => {
    await env.DB.prepare("UPDATE targets SET enabled = 0 WHERE id = 'quotes'").run();
    try {
      const net = bothTargets();
      const s = await runPipeline(env, "cron", net.deps);
      expect(s.targets.map((t) => t.target)).toEqual(["books"]);
      expect(net.calls.some((c) => c.url.startsWith(QUOTES))).toBe(false);
    } finally {
      await env.DB.prepare("UPDATE targets SET enabled = 1 WHERE id = 'quotes'").run();
    }
  });
});

describe("per-target isolation", () => {
  it("one broken site doesn't take down the run: status is partial, the other target is saved", async () => {
    const net = bothTargets();
    net.route(`${QUOTES}/`, () => new Response("down", { status: 502 }));
    const s = await runPipeline(env, "cron", net.deps);
    expect(s.status).toBe("partial");
    expect(s.targets.find((t) => t.target === "books")!.ok).toBe(true);
    expect(s.targets.find((t) => t.target === "quotes")!.ok).toBe(false);
    expect(await count("items", "target_id = 'books'")).toBe(60);
  });

  it("a crashing extractor is contained too", async () => {
    const net = bothTargets();
    const boom = { id: "quotes", name: "q", baseUrl: QUOTES, pages: [`${QUOTES}/`], schema: null as never, keyOf: () => "", extract: async () => { throw new Error("extractor bug"); } };
    const { books } = await import("../worker/src/targets/books");
    const s = await runPipeline(env, "cron", net.deps, [books, boom]);
    expect(s.status).toBe("partial");
    expect(s.notes).toEqual(expect.arrayContaining([expect.objectContaining({ target: "quotes", message: expect.stringContaining("extractor bug") })]));
  });
});

describe("retention", () => {
  it("deletes old snapshots but always keeps the latest one per item", async () => {
    await runPipeline(env, "cron", bothTargets().deps);
    const old = "2020-01-01T00:00:00.000Z";
    const { results } = await env.DB.prepare("SELECT id FROM items ORDER BY id LIMIT 2").all<{ id: number }>();
    const [a, b] = results.map((r) => r.id);
    const runId = (await env.DB.prepare("SELECT MAX(id) AS id FROM runs").first<{ id: number }>())!.id;
    const add = (item: number, hash: string, at: string) =>
      env.DB.prepare("INSERT INTO snapshots (item_id, run_id, hash, data_json, captured_at) VALUES (?, ?, ?, '{}', ?)").bind(item, runId, hash, at);

    // item a: an old, superseded snapshot followed by a newer one → the old one goes
    // item b: its only snapshot is old → kept, it's the baseline for the next diff
    await env.DB.batch([
      add(a, "old", old),
      add(a, "newer", new Date().toISOString()),
      env.DB.prepare("UPDATE snapshots SET captured_at = ? WHERE item_id = ?").bind(old, b),
    ]);

    const before = await count("snapshots");
    const r = await runRetention(env.DB);
    expect(r.snapshotsDeleted).toBe(1);
    expect(await count("snapshots")).toBe(before - 1);
    expect(await count("snapshots", "hash = 'old'")).toBe(0);
    expect(await count("snapshots", `item_id = ${b}`)).toBe(1);
  });

  it("deletes validation errors from old runs", async () => {
    await env.DB.prepare("INSERT INTO runs (id, started_at, trigger, status) VALUES (999, '2020-01-01T00:00:00Z', 'cron', 'ok')").run();
    await env.DB.prepare("INSERT INTO validation_errors (run_id, target_id, source_url, issues_json) VALUES (999, 'books', 'x', '[]')").run();
    const r = await runRetention(env.DB);
    expect(r.validationErrorsDeleted).toBe(1);
  });

  it("the retention cron runs retention, not a scrape", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: CRON_RETENTION, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await count("runs")).toBe(0);
  });
});

describe("alerting", () => {
  const summary = (over: Partial<RunSummary>): RunSummary => ({
    runId: 1, status: "ok", pagesFetched: 4, recordsValid: 70, recordsInvalid: 0, changesFound: 0, targets: [], notes: [], ...over,
  });

  it("alerts on failed/partial runs and on many changes", () => {
    expect(alertReasons(summary({}), 25)).toEqual([]);
    expect(alertReasons(summary({ status: "partial", targets: [{ target: "quotes", ok: false } as never] }), 25)).toEqual(["run partial (failed: quotes)"]);
    expect(alertReasons(summary({ changesFound: 30 }), 25)).toEqual(["30 changes (threshold 25)"]);
  });

  it("posts a JSON message with a text field when configured", async () => {
    const sent: { url: string; body: { text: string } }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const e = { ...env, ALERT_WEBHOOK_URL: "https://hooks.example/abc" };
    const failed = summary({ status: "failed", notes: [{ target: "books", level: "error", message: "fetch failed: HTTP 500", url: PAGE(1) }] });

    expect(await maybeAlert(e, summary({}), fake)).toBe(false); // nothing to report
    expect(await maybeAlert(e, failed, fake)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://hooks.example/abc");
    expect(sent[0].body.text).toContain("run #1: run failed");
    expect(sent[0].body.text).toContain("fetch failed: HTTP 500");
  });

  it("does nothing without a webhook URL, and never throws", async () => {
    expect(await maybeAlert(env, summary({ status: "failed" }))).toBe(false);
    const throwing = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await maybeAlert({ ...env, ALERT_WEBHOOK_URL: "https://x" }, summary({ status: "failed" }), throwing)).toBe(false);
  });
});
