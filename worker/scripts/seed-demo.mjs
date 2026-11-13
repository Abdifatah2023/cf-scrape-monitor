// Generate a week of realistic-looking demo history for the LOCAL D1 database,
// so the dashboard has something to show during development and for screenshots.
//
//   node scripts/seed-demo.mjs > .wrangler/demo.sql
//   npx wrangler d1 execute scrape-monitor --local --file .wrangler/demo.sql
//
// It wipes the local data tables first. Never run the output with --remote.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIX = join(import.meta.dirname, "../../test/fixtures");
const RATING = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };

// deterministic PRNG so the demo looks the same every time
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const decode = (s) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// ---- items from the saved fixtures -------------------------------------------------
const books = [];
for (const n of [1, 2, 3]) {
  const html = readFileSync(join(FIX, `books-page-${n}.html`), "utf8");
  for (const art of html.split('<article class="product_pod">').slice(1)) {
    const href = /<h3><a href="([^"]+)" title="([^"]*)"/.exec(art);
    const price = /price_color">£([\d.]+)</.exec(art);
    const rating = /star-rating (\w+)/.exec(art);
    books.push({
      target: "books",
      key: new URL(href[1], `https://books.toscrape.com/catalogue/page-${n}.html`).toString(),
      data: {
        url: new URL(href[1], `https://books.toscrape.com/catalogue/page-${n}.html`).toString(),
        title: decode(href[2]),
        price: Number(price[1]),
        in_stock: true,
        rating: RATING[rating[1]],
        source_url: `https://books.toscrape.com/catalogue/page-${n}.html`,
      },
    });
  }
}
const quotes = [];
{
  const html = readFileSync(join(FIX, "quotes-page-1.html"), "utf8");
  for (const q of html.split('<div class="quote"').slice(1)) {
    const text = decode(/<span class="text"[^>]*>([^<]*)</.exec(q)[1]).replace(/^“|”$/g, "");
    const author = decode(/<small class="author"[^>]*>([^<]*)</.exec(q)[1]);
    const tags = [...q.matchAll(/<a class="tag"[^>]*>([^<]*)</g)].map((m) => m[1].toLowerCase()).sort();
    quotes.push({ target: "quotes", key: `${author}: ${text}`, data: { text, author, tags, source_url: "https://quotes.toscrape.com/" } });
  }
}
const items = [...books, ...quotes];

// ---- helpers -----------------------------------------------------------------------
const sql = [];
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const canon = (o) => {
  const { source_url, ...rest } = o;
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(rest));
};
const hash = (d) => createHash("sha256").update(canon(d)).digest("hex");
const text = (v) => (typeof v === "string" ? v : JSON.stringify(v));

sql.push("DELETE FROM changes; DELETE FROM snapshots; DELETE FROM validation_errors; DELETE FROM items; DELETE FROM runs; DELETE FROM fetch_cache; DELETE FROM robots_cache;");
sql.push("DELETE FROM sqlite_sequence WHERE name IN ('changes','snapshots','validation_errors','items','runs');");

// ---- simulate 28 runs, every 6 h, ending ~1 h ago ----------------------------------
const RUNS = 28;
const end = Date.now() - 3600_000;
const state = items.map((it, i) => ({ ...it, id: i + 1, data: { ...it.data }, removed: false, first: null, last: null }));

for (let r = 1; r <= RUNS; r++) {
  const t0 = new Date(end - (RUNS - r) * 6 * 3600_000);
  const iso = (ms = 0) => new Date(t0.getTime() + ms).toISOString();
  const now = iso(4200);
  let status = "ok";
  const notes = [];
  let changes = 0;
  let invalid = 0;
  let pages = 4;

  if (r === 10) {
    status = "partial";
    pages = 3;
    notes.push({ target: "books", level: "error", message: "fetch failed: HTTP 503", url: "https://books.toscrape.com/catalogue/page-2.html" });
  }
  if (r === 18) {
    status = "failed";
    pages = 0;
    notes.push({ target: "books", level: "error", message: "fetch failed: timed out after 10 s", url: "https://books.toscrape.com/catalogue/page-1.html" });
    notes.push({ target: "quotes", level: "error", message: "fetch failed: timed out after 10 s", url: "https://quotes.toscrape.com/" });
  }
  if (r % 4 === 2 && r !== 18) notes.push({ target: "books", level: "info", message: "not modified (304)", url: "https://books.toscrape.com/catalogue/page-3.html" });

  sql.push(`INSERT INTO runs (id, started_at, trigger, status) VALUES (${r}, ${q(iso())}, ${q(r === 27 ? "manual" : "cron")}, 'running');`);

  if (status !== "failed") {
    for (const it of state) {
      if (r === 10 && it.target === "books" && it.data.source_url.endsWith("page-2.html")) continue;
      const change = (kind, field, oldV, newV) => {
        changes++;
        sql.push(`INSERT INTO changes (item_id, run_id, kind, field, old_value, new_value, detected_at) VALUES (${it.id}, ${r}, ${q(kind)}, ${q(field)}, ${q(oldV)}, ${q(newV)}, ${q(now)});`);
      };
      const snap = () =>
        sql.push(`INSERT INTO snapshots (item_id, run_id, hash, data_json, captured_at) VALUES (${it.id}, ${r}, ${q(hash(it.data))}, ${q(JSON.stringify(it.data))}, ${q(now)});`);

      if (r === 1) {
        it.first = now;
        it.last = now;
        sql.push(`INSERT INTO items (id, target_id, item_key, first_seen, last_seen, current_hash) VALUES (${it.id}, ${q(it.target)}, ${q(it.key)}, ${q(now)}, ${q(now)}, ${q(hash(it.data))});`);
        snap();
        change("added", null, null, null);
        continue;
      }

      // one book disappears at run 13 and comes back at run 21
      if (it.id === 7 && r === 13) {
        it.removed = now;
        change("removed", null, null, null);
        continue;
      }
      if (it.id === 7 && r > 13 && r < 21) continue;
      if (it.id === 7 && r === 21) {
        it.removed = false;
        change("added", null, null, null);
      }

      const before = { ...it.data, tags: it.data.tags ? [...it.data.tags] : undefined };
      if (it.target === "books") {
        // a handful of books get repriced over the week
        if ([1, 3, 12, 25, 33, 48].includes(it.id) && rand() < 0.3) {
          const factor = pick([0.85, 0.9, 0.95, 1.05, 1.1]);
          it.data.price = Math.round(it.data.price * factor * 100) / 100;
        }
        if ([5, 19, 41].includes(it.id) && rand() < 0.15) it.data.in_stock = !it.data.in_stock;
        if (it.id === 1 && r === 16) it.data.price = 39.99; // a visible sale on the first book
        if (it.id === 1 && r === 24) it.data.price = 47.5;
      } else if (it.id === items.length - 2 && r === 15) {
        it.data.tags = [...it.data.tags, "inspirational"].sort();
      }
      if (before.tags === undefined) delete before.tags;

      const fields = Object.keys(it.data).filter((k) => k !== "source_url" && text(before[k]) !== text(it.data[k]));
      if (fields.length) {
        snap();
        for (const f of fields.sort()) change("updated", f, text(before[f]), text(it.data[f]));
        sql.push(`UPDATE items SET current_hash = ${q(hash(it.data))} WHERE id = ${it.id};`);
      }
      it.last = now;
      sql.push(`UPDATE items SET last_seen = ${q(now)}, removed_at = NULL WHERE id = ${it.id};`);
    }
    if (it7Removed()) sql.push(`UPDATE items SET removed_at = ${q(state[6].removed)} WHERE id = 7;`);

    // a couple of runs extract records that fail validation
    if (r === 6 || r === 22) {
      const bad = [
        { url: "https://books.toscrape.com/catalogue/page-3.html", issues: [{ code: "too_small", path: ["price"], message: "Too small: expected number to be >0" }], raw: { url: "https://books.toscrape.com/catalogue/x_1/index.html", title: "Mystery Box", price: "£0.00", in_stock: "In stock", rating: "Two" } },
        { url: "https://books.toscrape.com/catalogue/page-1.html", issues: [{ code: "invalid_value", path: ["rating"], message: 'Invalid option: expected one of "One"|"Two"|"Three"|"Four"|"Five"' }], raw: { url: "https://books.toscrape.com/catalogue/y_2/index.html", title: "Unrated", price: "£12.00", in_stock: "In stock", rating: "" } },
      ];
      for (const b of bad) {
        invalid++;
        sql.push(`INSERT INTO validation_errors (run_id, target_id, source_url, issues_json, raw_json) VALUES (${r}, 'books', ${q(b.url)}, ${q(JSON.stringify(b.issues))}, ${q(JSON.stringify(b.raw))});`);
      }
    }
  }

  const valid = status === "failed" ? 0 : r === 10 ? 50 : 70 - (r > 13 && r < 21 ? 1 : 0);
  sql.push(
    `UPDATE runs SET finished_at = ${q(iso(5100))}, status = ${q(status)}, pages_fetched = ${pages}, records_valid = ${valid}, records_invalid = ${invalid}, changes_found = ${changes}, notes = ${q(notes.length ? JSON.stringify(notes) : null)} WHERE id = ${r};`,
  );
}

function it7Removed() {
  return !!state[6].removed;
}

process.stdout.write(sql.join("\n") + "\n");
