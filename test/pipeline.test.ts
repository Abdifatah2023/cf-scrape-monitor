import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runPipeline } from "../worker/src/pipeline";
import { BOOK_PAGES, BOOKS, count, fakeNet, html200, PAGE, resetDb } from "./helpers";

import broken from "./fixtures/books-broken.html?raw";

beforeEach(resetDb);

describe("Milestone 1: first run", () => {
  it("writes all 60 books as items, snapshots and 'added' changes", async () => {
    const net = fakeNet();
    const s = await runPipeline(env, "cron", net.deps);

    expect(s.status).toBe("ok");
    expect(s.pagesFetched).toBe(3);
    expect(s.recordsValid).toBe(60);
    expect(await count("items")).toBe(60);
    expect(await count("snapshots")).toBe(60);
    expect(await count("changes", "kind = 'added'")).toBe(60);

    const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(s.runId).first();
    expect(run).toMatchObject({ trigger: "cron", status: "ok", pages_fetched: 3, records_valid: 60, changes_found: 60 });
    expect(run!.finished_at).toBeTruthy();
  });
});

describe("Milestone 2: validation", () => {
  it("stores invalid records in validation_errors and keeps going", async () => {
    const net = fakeNet();
    net.route(PAGE(2), broken);
    const s = await runPipeline(env, "cron", net.deps);

    expect(s.status).toBe("ok"); // bad records are not a failed run
    expect(s.recordsInvalid).toBe(3);
    expect(s.recordsValid).toBe(41); // 20 + 1 good one in the broken page + 20
    expect(await count("validation_errors")).toBe(3);

    const { results } = await env.DB.prepare(
      "SELECT source_url, issues_json, raw_json FROM validation_errors ORDER BY id",
    ).all<{ source_url: string; issues_json: string; raw_json: string }>();
    const paths = results.map((r) => JSON.parse(r.issues_json).map((i: { path: string[] }) => i.path[0]));
    expect(paths[0]).toContain("price");
    expect(paths[1]).toContain("rating");
    expect(paths[2]).toEqual(expect.arrayContaining(["url", "title"]));
    expect(results.every((r) => r.source_url === PAGE(2))).toBe(true);
    expect(JSON.parse(results[0].raw_json).price).toBe("£N/A");
  });
});

describe("Milestone 3: change detection", () => {
  it("a second run with unchanged data writes 0 snapshots and 0 changes", async () => {
    await runPipeline(env, "cron", fakeNet().deps);
    const s2 = await runPipeline(env, "cron", fakeNet().deps);

    expect(s2.changesFound).toBe(0);
    expect(await count("snapshots")).toBe(60);
    expect(await count("changes")).toBe(60);
    expect(await count("snapshots", `run_id = ${s2.runId}`)).toBe(0);
  });

  it("a modified fixture writes one change row per changed field", async () => {
    await runPipeline(env, "cron", fakeNet().deps);

    const net = fakeNet();
    // A Light in the Attic: price 51.77 → 45.00 and goes out of stock
    const modified = BOOK_PAGES[PAGE(1)]
      .replace("£51.77", "£45.00")
      .replace(/(£45\.00<\/p>\s*<p class="instock availability">\s*<i class="icon-ok"><\/i>\s*)In stock/, "$1Out of stock");
    expect(modified).not.toBe(BOOK_PAGES[PAGE(1)]);
    net.route(PAGE(1), modified);
    const s2 = await runPipeline(env, "cron", net.deps);

    const { results } = await env.DB.prepare(
      "SELECT kind, field, old_value, new_value FROM changes WHERE run_id = ? ORDER BY field",
    )
      .bind(s2.runId)
      .all();
    expect(results).toEqual([
      { kind: "updated", field: "in_stock", old_value: "true", new_value: "false" },
      { kind: "updated", field: "price", old_value: "51.77", new_value: "45" },
    ]);
    expect(await count("snapshots", `run_id = ${s2.runId}`)).toBe(1);
    expect(s2.changesFound).toBe(2);
  });

  it("marks items removed only when every page was fetched cleanly", async () => {
    await runPipeline(env, "cron", fakeNet().deps);

    // page 3 now lists only its first 5 books → 15 removed
    const net = fakeNet();
    const parts = BOOK_PAGES[PAGE(3)].split('<article class="product_pod">');
    net.route(PAGE(3), [parts[0], ...parts.slice(1, 6)].join('<article class="product_pod">') + "</ol></body></html>");
    const s2 = await runPipeline(env, "cron", net.deps);
    expect(await count("changes", `run_id = ${s2.runId} AND kind = 'removed'`)).toBe(15);
    expect(await count("items", "removed_at IS NOT NULL")).toBe(15);

    // reported once, not on every later run
    const s3 = await runPipeline(env, "cron", net.deps);
    expect(await count("changes", `run_id = ${s3.runId}`)).toBe(0);

    // they come back → 'added' again
    const s4 = await runPipeline(env, "cron", fakeNet().deps);
    expect(await count("changes", `run_id = ${s4.runId} AND kind = 'added'`)).toBe(15);
    expect(await count("items", "removed_at IS NOT NULL")).toBe(0);
  });

  it("ignores provenance: a book moving to another page is not a change", async () => {
    await runPipeline(env, "cron", fakeNet().deps);
    const net = fakeNet();
    // swap pages 1 and 2
    net.route(PAGE(1), BOOK_PAGES[PAGE(2)]);
    net.route(PAGE(2), BOOK_PAGES[PAGE(1)]);
    const s2 = await runPipeline(env, "cron", net.deps);
    expect(s2.changesFound).toBe(0);
  });
});

describe("Failure cases", () => {
  it("500 → retried once, then the page fails; items on it are NOT marked removed", async () => {
    await runPipeline(env, "cron", fakeNet().deps);

    const net = fakeNet();
    net.route(PAGE(2), () => new Response("boom", { status: 500 }));
    const s = await runPipeline(env, "cron", net.deps);

    expect(net.calls.filter((c) => c.url === PAGE(2))).toHaveLength(2); // original + 1 retry
    expect(s.status).toBe("failed"); // the only enabled target failed
    expect(s.targets[0].removalsChecked).toBe(false);
    expect(await count("changes", "kind = 'removed'")).toBe(0);
    const run = await env.DB.prepare("SELECT notes FROM runs WHERE id = ?").bind(s.runId).first<{ notes: string }>();
    expect(JSON.parse(run!.notes)).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "error", url: PAGE(2), message: "fetch failed: HTTP 500" })]),
    );
  });

  it("500 then 200 → recovers on the retry", async () => {
    const net = fakeNet();
    let n = 0;
    net.route(PAGE(1), () => (n++ === 0 ? new Response("", { status: 503 }) : html200(BOOK_PAGES[PAGE(1)])));
    const s = await runPipeline(env, "cron", net.deps);
    expect(s.status).toBe("ok");
    expect(s.recordsValid).toBe(60);
    expect(net.sleeps).toContain(2000); // backoff
  });

  it("429 with Retry-After is respected", async () => {
    const net = fakeNet();
    let n = 0;
    net.route(PAGE(1), () =>
      n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : html200(BOOK_PAGES[PAGE(1)]),
    );
    const s = await runPipeline(env, "cron", net.deps);
    expect(s.status).toBe("ok");
    expect(net.sleeps).toContain(7000);
  });

  it("timeout → retried, then reported", async () => {
    const net = fakeNet();
    net.route(PAGE(3), () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const s = await runPipeline(env, "cron", net.deps);
    expect(net.calls.filter((c) => c.url === PAGE(3))).toHaveLength(2);
    expect(s.notes).toEqual(expect.arrayContaining([expect.objectContaining({ message: "fetch failed: timed out after 10 s" })]));
    expect(s.recordsValid).toBe(40);
  });

  it("304 → conditional headers sent, page skipped cheaply, nothing removed", async () => {
    const net1 = fakeNet();
    for (const [url, html] of Object.entries(BOOK_PAGES)) {
      net1.route(url, () => html200(html, { etag: `"v1-${url.slice(-6)}"`, "last-modified": "Wed, 08 Feb 2023 21:02:32 GMT" }));
    }
    await runPipeline(env, "cron", net1.deps);

    const net2 = fakeNet();
    for (const url of Object.keys(BOOK_PAGES)) {
      net2.route(url, (req) =>
        req.headers["if-none-match"] === `"v1-${url.slice(-6)}"` ? new Response(null, { status: 304 }) : html200("changed?"),
      );
    }
    const s = await runPipeline(env, "cron", net2.deps);

    const pageCalls = net2.calls.filter((c) => c.url.includes("/catalogue/"));
    expect(pageCalls.every((c) => c.headers["if-modified-since"] === "Wed, 08 Feb 2023 21:02:32 GMT")).toBe(true);
    expect(s.status).toBe("ok");
    expect(s.targets[0].pagesNotModified).toBe(3);
    expect(s.changesFound).toBe(0);
    expect(await count("changes", "kind = 'removed'")).toBe(0);
  });

  it("malformed HTML (0 records) is a failure, not a mass deletion", async () => {
    await runPipeline(env, "cron", fakeNet().deps);
    const net = fakeNet();
    net.route(PAGE(1), "<html><body><h1>Down for maintenance</h1><div");
    const s = await runPipeline(env, "cron", net.deps);
    expect(s.status).toBe("failed");
    expect(await count("changes", "kind = 'removed'")).toBe(0);
    expect(s.notes).toEqual(expect.arrayContaining([expect.objectContaining({ message: "page parsed to 0 records" })]));
  });

  it("robots.txt disallow → page skipped and the reason recorded", async () => {
    const net = fakeNet();
    net.route(`${BOOKS}/robots.txt`, () => new Response("User-agent: *\nDisallow: /catalogue/page-2.html\n"));
    const s = await runPipeline(env, "cron", net.deps);

    expect(net.calls.some((c) => c.url === PAGE(2))).toBe(false);
    expect(s.recordsValid).toBe(40);
    expect(s.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "warn", url: PAGE(2), message: expect.stringContaining("disallowed") })]),
    );
  });

  it("robots.txt is cached for 24 h (fetched once across runs)", async () => {
    const net = fakeNet();
    await runPipeline(env, "cron", net.deps);
    await runPipeline(env, "cron", net.deps);
    expect(net.calls.filter((c) => c.url.endsWith("/robots.txt"))).toHaveLength(1);
  });
});

describe("Milestone 4: politeness", () => {
  it("sends the identifying User-Agent on every request", async () => {
    const net = fakeNet();
    await runPipeline(env, "cron", net.deps);
    expect(net.calls.length).toBeGreaterThan(0);
    expect(net.calls.every((c) => c.headers["user-agent"] === env.USER_AGENT)).toBe(true);
  });

  it("requests go one at a time with a delay between them", async () => {
    const net = fakeNet();
    let inFlight = 0;
    let maxInFlight = 0;
    for (const [url, html] of Object.entries(BOOK_PAGES)) {
      net.route(url, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return html200(html);
      });
    }
    const delayed = { ...env, REQUEST_DELAY_MS: "1500" };
    await runPipeline(delayed, "cron", net.deps);
    expect(maxInFlight).toBe(1);
    // robots + 3 pages to one host → 3 waits, each close to 1500 ms
    expect(net.sleeps).toHaveLength(3);
    for (const ms of net.sleeps) expect(ms).toBeGreaterThan(1400);
  });
});
