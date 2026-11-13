// cf-scrape-monitor dashboard — vanilla JS, no build step.
// All API data is inserted with textContent (via h()), never innerHTML.
"use strict";

/* ------------------------------------------------------------------ helpers */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (sel) => document.querySelector(sel);

async function api(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status} for ${path}`);
  return body;
}

const dtf = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const nf = new Intl.NumberFormat(undefined);
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function fmtTime(iso) {
  return iso ? dtf.format(new Date(iso)) : "—";
}
function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} days ago`;
}
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** Compact "key  value" list for a record, skipping noisy keys. */
function kv(obj, omit = []) {
  if (!obj || typeof obj !== "object") return h("span", { class: "mono" }, String(obj));
  return h(
    "div",
    { class: "kv" },
    Object.entries(obj)
      .filter(([k]) => !omit.includes(k))
      .map(([k, v]) => h("div", {}, h("span", { class: "k" }, k), JSON.stringify(v))),
  );
}

function fmtNum(n) {
  return n >= 10000 ? compact.format(n) : nf.format(n);
}

const STATUS_LABEL = { ok: "OK", partial: "Partial", failed: "Failed", running: "Running" };
function statusEl(status) {
  return h("span", { class: `status ${status}` }, STATUS_LABEL[status] || status);
}
function kindEl(kind) {
  return h("span", { class: "kind" }, kind);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function table(headers, rows, emptyText = "Nothing here yet.") {
  const thead = h("thead", {}, h("tr", {}, headers.map((c) => h("th", { class: c.num ? "num" : null }, c.label ?? c))));
  const tbody = h("tbody");
  if (!rows.length) {
    tbody.append(h("tr", {}, h("td", { colspan: headers.length, class: "empty" }, emptyText)));
  }
  for (const r of rows) tbody.append(r);
  return h("div", { class: "table-wrap" }, h("table", {}, thead, tbody));
}

function showError(err) {
  console.error(err);
  $("main").prepend(h("div", { class: "card error-banner" }, h("strong", {}, "Couldn't load data. "), String(err.message || err)));
}

function targetName(id) {
  return { books: "Books", quotes: "Quotes" }[id] || id;
}

function changeValue(c) {
  if (c.kind !== "updated") return h("span", { class: "muted" }, c.kind === "added" ? "new item" : "no longer listed");
  return h(
    "span",
    {},
    h("span", { class: "old" }, c.old_value ?? "∅"),
    h("span", { class: "arrow", "aria-label": "changed to" }, "→"),
    h("strong", {}, c.new_value ?? "∅"),
  );
}

function changeRow(c, { showTarget = true } = {}) {
  return h(
    "tr",
    {},
    h("td", { class: "t" }, fmtTime(c.detected_at)),
    showTarget ? h("td", {}, targetName(c.target_id)) : null,
    h("td", { class: "wrap" }, h("a", { href: `item.html?id=${encodeURIComponent(c.item_id)}` }, c.item_label || c.item_key)),
    h("td", {}, kindEl(c.kind), c.field ? h("span", { class: "muted" }, " ", c.field) : null),
    h("td", { class: "wrap" }, changeValue(c)),
  );
}

/* Chart chrome shared by every chart: hairline solid grid, muted ticks, no Chart.js legend. */
function baseChartOptions() {
  const grid = cssVar("--grid");
  const axis = cssVar("--axis");
  const muted = cssVar("--muted");
  Chart.defaults.font.family = cssVar("--font");
  Chart.defaults.color = muted;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar("--surface"),
        borderColor: cssVar("--ring"),
        borderWidth: 1,
        titleColor: cssVar("--ink-2"),
        bodyColor: cssVar("--ink"),
        bodyFont: { weight: "600" },
        padding: 10,
        displayColors: false,
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: axis }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 16 } },
      y: { beginAtZero: true, grid: { color: grid, lineWidth: 1 }, border: { display: false }, ticks: { color: muted, precision: 0 } },
    },
  };
}

/* Vertical hairline that tracks the active tooltip x (crosshair). */
const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const t = chart.tooltip;
    if (!t || !t.getActiveElements().length) return;
    const x = t.getActiveElements()[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar("--axis");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/* ------------------------------------------------------------------ overview */

async function pageOverview() {
  const [summary, runsRes, changesRes] = await Promise.all([
    api("/api/summary"),
    api("/api/runs?limit=60"),
    api("/api/changes?limit=12"),
  ]);
  const t = summary.totals;
  const last = summary.last_run;

  $("#generated").textContent = `Updated ${fmtTime(summary.generated_at)}`;

  const tile = (label, value, note) =>
    h("div", { class: "card tile" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), note ? h("div", { class: "note" }, note) : null);

  const rate = summary.success_rate_7d;
  $("#tiles").replaceChildren(
    tile("Last run", last ? statusEl(last.status) : "—", last ? `${ago(last.finished_at)} · ${last.trigger}` : "No runs yet"),
    tile(
      "Success rate (7 days)",
      rate === null ? "—" : `${Math.round(rate * 100)}%`,
      `${summary.runs_7d.by_status.ok || 0} of ${summary.runs_7d.total} runs OK`,
    ),
    tile("Items tracked", fmtNum(t.items_tracked), `${fmtNum(t.items_removed)} removed · ${fmtNum(t.snapshots)} snapshots`),
    tile("Changes (7 days)", fmtNum(t.changes_7d), `${fmtNum(t.changes_24h)} in the last 24 h`),
  );

  // per-target notes from the last run (robots skips, fetch failures)
  if (last && last.notes.some((n) => n.level !== "info")) {
    $("#last-run-notes").replaceChildren(
      h("h2", {}, `Run #${last.id} reported problems`),
      h("ul", {}, last.notes.filter((n) => n.level !== "info").map((n) => h("li", {}, `${targetName(n.target)}: ${n.message}`, n.url ? h("span", { class: "muted mono" }, ` ${n.url}`) : null))),
    );
    $("#last-run-notes").hidden = false;
  }

  renderRunsChart(runsRes.runs.slice().reverse());

  $("#latest-changes").replaceChildren(
    table(["Time", "Target", "Item", "Change", "Value"], changesRes.changes.map((c) => changeRow(c)), "No changes recorded yet."),
  );
}

function renderRunsChart(runs) {
  const colorFor = { ok: cssVar("--good"), partial: cssVar("--warning"), failed: cssVar("--critical"), running: cssVar("--axis") };
  const labels = runs.map((r) => fmtTime(r.started_at));
  const opts = baseChartOptions();
  opts.plugins.tooltip.callbacks = {
    title: (items) => {
      const r = runs[items[0].dataIndex];
      return `Run #${r.id} · ${fmtTime(r.started_at)} · ${r.trigger}`;
    },
    label: (item) => {
      if (item.datasetIndex === 1) return null; // zero-marker duplicates the bar row
      const r = runs[item.dataIndex];
      return [
        `${nf.format(r.changes_found)} changes`,
        `${STATUS_LABEL[r.status] || r.status} · ${r.pages_fetched} pages · ${r.records_valid} valid · ${r.records_invalid} invalid`,
      ];
    },
  };
  opts.interaction = { mode: "index", intersect: false };
  opts.scales.y.title = { display: true, text: "Changes per run", color: cssVar("--muted") };

  new Chart($("#runs-chart"), {
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          data: runs.map((r) => r.changes_found),
          backgroundColor: runs.map((r) => colorFor[r.status] || colorFor.running),
          hoverBackgroundColor: runs.map((r) => colorFor[r.status] || colorFor.running),
          maxBarThickness: 24,
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: "start",
          categoryPercentage: 0.8,
          barPercentage: 0.9,
        },
        {
          // runs with 0 changes still show their status: a dot on the baseline
          type: "line",
          showLine: false,
          data: runs.map((r) => (r.changes_found === 0 ? 0 : null)),
          pointRadius: 4,
          pointHoverRadius: 5,
          pointBackgroundColor: runs.map((r) => colorFor[r.status] || colorFor.running),
          pointBorderColor: cssVar("--surface"),
          pointBorderWidth: 2,
          clip: false,
        },
      ],
    },
    options: opts,
    plugins: [crosshair],
  });

  $("#runs-legend").replaceChildren(
    statusEl("ok"),
    statusEl("partial"),
    statusEl("failed"),
    h("span", { class: "muted" }, "Dot on the baseline = run with no changes"),
  );

  $("#runs-table").replaceChildren(
    table(
      ["Run", "Started", "Trigger", "Status", { label: "Pages", num: true }, { label: "Valid", num: true }, { label: "Invalid", num: true }, { label: "Changes", num: true }],
      runs
        .slice()
        .reverse()
        .map((r) =>
          h(
            "tr",
            {},
            h("td", { class: "t" }, `#${r.id}`),
            h("td", { class: "t" }, fmtTime(r.started_at)),
            h("td", {}, r.trigger),
            h("td", {}, statusEl(r.status)),
            h("td", { class: "num" }, r.pages_fetched),
            h("td", { class: "num" }, r.records_valid),
            h("td", { class: "num" }, r.records_invalid),
            h("td", { class: "num" }, r.changes_found),
          ),
        ),
    ),
  );
}

/* ------------------------------------------------------------------ change feed */

async function pageChanges() {
  const params = new URLSearchParams(location.search);
  const form = $("#filters");
  for (const [k, v] of params) if (form.elements[k]) form.elements[k].value = v;

  const { targets } = await api("/api/targets");
  const sel = form.elements.target;
  for (const t of targets) sel.append(h("option", { value: t.id }, t.name));
  if (params.get("target")) sel.value = params.get("target");

  let nextBefore = null;
  const tbody = () => $("#feed tbody");

  async function load(append) {
    const q = new URLSearchParams();
    for (const name of ["target", "kind", "field"]) {
      const v = form.elements[name].value;
      if (v) q.set(name, v);
    }
    const range = form.elements.range.value;
    if (range) q.set("since", new Date(Date.now() - Number(range) * 3600_000).toISOString());
    if (append && nextBefore) q.set("before", String(nextBefore));
    q.set("limit", "50");

    $("#feed").classList.add("loading");
    try {
      const res = await api(`/api/changes?${q}`);
      nextBefore = res.next_before;
      const rows = res.changes.map((c) => changeRow(c));
      if (append) tbody().append(...rows);
      else $("#feed").replaceChildren(table(["Time", "Target", "Item", "Change", "Old → new"], rows, "No changes match these filters."));
      $("#more").hidden = !nextBefore;
    } finally {
      $("#feed").classList.remove("loading");
    }
  }

  form.addEventListener("change", () => {
    const q = new URLSearchParams();
    for (const name of ["target", "kind", "field", "range"]) if (form.elements[name].value) q.set(name, form.elements[name].value);
    history.replaceState(null, "", q.toString() ? `?${q}` : location.pathname);
    load(false).catch(showError);
  });
  $("#more").addEventListener("click", () => load(true).catch(showError));
  await load(false);
}

/* ------------------------------------------------------------------ item detail */

const NUMERIC_LABELS = { price: "Price (£)", rating: "Rating (1–5 stars)" };

async function pageItem() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return itemBrowser();
  $("#browser").hidden = true;
  $("#detail").hidden = false;

  const { item, snapshots, changes } = await api(`/api/items/${encodeURIComponent(id)}/history`);
  document.title = `${item.label} · cf-scrape-monitor`;
  $("#item-title").textContent = item.label;
  const isUrl = /^https?:\/\//.test(item.item_key);
  $("#item-meta").replaceChildren(
    h(
      "span",
      {},
      `${targetName(item.target_id)} · first seen ${fmtTime(item.first_seen)} · last seen ${fmtTime(item.last_seen)}`,
      item.removed_at ? h("span", {}, " · ", h("span", { class: "status failed" }, `Removed ${fmtTime(item.removed_at)}`)) : null,
      isUrl ? h("span", {}, " · ", h("a", { href: item.item_key, rel: "noopener noreferrer", target: "_blank" }, "source page ↗")) : null,
    ),
  );

  // numeric fields present in the snapshots can be charted
  const latest = snapshots[snapshots.length - 1]?.data || {};
  const numeric = Object.keys(latest).filter((k) => typeof latest[k] === "number");
  if (numeric.length) {
    const pick = $("#field");
    pick.replaceChildren(...numeric.map((f) => h("option", { value: f }, NUMERIC_LABELS[f] || f)));
    let chart = null;
    const draw = () => {
      chart?.destroy();
      chart = renderHistoryChart(item, snapshots, pick.value);
    };
    pick.addEventListener("change", draw);
    draw();
  } else {
    $("#chart-card").hidden = true;
  }

  $("#snapshots").replaceChildren(
    snapshots.length
      ? h(
          "ol",
          { class: "timeline" },
          snapshots
            .slice()
            .reverse()
            .map((s) =>
              h(
                "li",
                {},
                h("div", { class: "when" }, fmtTime(s.captured_at), h("div", { class: "muted mono" }, `run #${s.run_id} · ${s.hash.slice(0, 10)}`)),
                kv(s.data, ["url", "source_url"]),
              ),
            ),
        )
      : h("p", { class: "empty" }, "No snapshots."),
  );

  $("#item-changes").replaceChildren(
    table(
      ["Time", "Change", "Old → new"],
      changes.map((c) =>
        h("tr", {}, h("td", { class: "t" }, fmtTime(c.detected_at)), h("td", {}, kindEl(c.kind), c.field ? h("span", { class: "muted" }, " ", c.field) : null), h("td", { class: "wrap" }, changeValue(c))),
      ),
      "No changes.",
    ),
  );
}

function renderHistoryChart(item, snapshots, field) {
  const pts = snapshots.filter((s) => typeof s.data[field] === "number").map((s) => ({ x: Date.parse(s.captured_at), y: s.data[field], snap: true }));
  // the value holds until the item was last seen (or removed): extend the step to there
  const end = Date.parse(item.removed_at || item.last_seen);
  if (pts.length && end > pts[pts.length - 1].x) pts.push({ x: end, y: pts[pts.length - 1].y, snap: false });

  const accent = cssVar("--accent");
  const opts = baseChartOptions();
  const span = pts.length > 1 ? pts[pts.length - 1].x - pts[0].x : 0;
  opts.scales.x = {
    type: "linear",
    grid: { display: false },
    border: { color: cssVar("--axis") },
    ticks: { color: cssVar("--muted"), maxRotation: 0, autoSkip: true, autoSkipPadding: 24, callback: (v) => dayFmt.format(new Date(v)) },
    min: pts.length ? pts[0].x - span * 0.02 : undefined,
    max: pts.length ? pts[pts.length - 1].x + span * 0.02 : undefined,
    // one tick per local midnight instead of arbitrary millisecond steps
    afterBuildTicks: (axis) => {
      const ticks = [];
      const d = new Date(axis.min);
      d.setHours(24, 0, 0, 0);
      for (; d.getTime() <= axis.max; d.setDate(d.getDate() + 1)) ticks.push({ value: d.getTime() });
      if (ticks.length) axis.ticks = ticks;
    },
  };
  opts.scales.y.beginAtZero = field === "rating";
  if (field === "rating") opts.scales.y.max = 5;
  opts.interaction = { mode: "nearest", axis: "x", intersect: false };
  opts.plugins.tooltip.filter = (i) => pts[i.dataIndex].snap;
  opts.plugins.tooltip.callbacks = {
    title: (items) => fmtTime(new Date(items[0].parsed.x).toISOString()),
    label: (i) => `${field === "price" ? "£" + i.parsed.y.toFixed(2) : i.parsed.y}  ${NUMERIC_LABELS[field] || field}`,
  };

  const chart = new Chart($("#history-chart"), {
    type: "line",
    data: {
      datasets: [
        {
          data: pts,
          stepped: "after",
          borderColor: accent,
          borderWidth: 2,
          borderJoinStyle: "round",
          borderCapStyle: "round",
          backgroundColor: cssVar("--accent-wash"),
          fill: false, // the y-axis does not start at zero, so an area would misstate magnitude
          pointRadius: pts.map((p) => (p.snap ? 4 : 0)),
          pointHoverRadius: pts.map((p) => (p.snap ? 5 : 0)),
          pointHitRadius: 12,
          pointBackgroundColor: accent,
          pointBorderColor: cssVar("--surface"),
          pointBorderWidth: 2,
        },
      ],
    },
    options: opts,
    plugins: [crosshair],
  });

  $("#chart-title").textContent = `${NUMERIC_LABELS[field] || field} over time`;
  $("#history-table").replaceChildren(
    table(
      ["Captured", { label: NUMERIC_LABELS[field] || field, num: true }],
      pts.filter((p) => p.snap).map((p) => h("tr", {}, h("td", { class: "t" }, fmtTime(new Date(p.x).toISOString())), h("td", { class: "num" }, p.y))),
    ),
  );
  return chart;
}

async function itemBrowser() {
  const form = $("#item-filters");
  const { targets } = await api("/api/targets");
  for (const t of targets) form.elements.target.append(h("option", { value: t.id }, t.name));

  async function load() {
    const q = new URLSearchParams({ limit: "500" });
    if (form.elements.target.value) q.set("target", form.elements.target.value);
    if (form.elements.q.value.trim()) q.set("q", form.elements.q.value.trim());
    $("#items").classList.add("loading");
    try {
      const { items } = await api(`/api/items?${q}`);
      $("#items").replaceChildren(
        table(
          ["Item", "Target", { label: "Snapshots", num: true }, { label: "Updates", num: true }, "Last seen"],
          items.map((i) =>
            h(
              "tr",
              {},
              h("td", { class: "wrap" }, h("a", { href: `item.html?id=${i.id}` }, i.label), i.removed_at ? h("span", { class: "muted" }, " (removed)") : null),
              h("td", {}, targetName(i.target_id)),
              h("td", { class: "num" }, i.snapshots),
              h("td", { class: "num" }, i.updates),
              h("td", { class: "t" }, fmtTime(i.last_seen)),
            ),
          ),
          "No items match.",
        ),
      );
    } finally {
      $("#items").classList.remove("loading");
    }
  }
  let timer;
  form.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => load().catch(showError), 200);
  });
  form.addEventListener("submit", (e) => e.preventDefault());
  await load();
}

/* ------------------------------------------------------------------ data quality */

async function pageQuality() {
  const [errs, runsRes] = await Promise.all([api("/api/errors?limit=500"), api("/api/runs?limit=100")]);

  $("#groups").replaceChildren(
    table(
      ["Target", "Field", "Issue", "Message", { label: "Count", num: true }, "Last seen"],
      errs.groups.map((g) =>
        h("tr", {}, h("td", {}, targetName(g.target_id)), h("td", { class: "mono" }, g.field), h("td", { class: "mono" }, g.code), h("td", { class: "wrap" }, g.message), h("td", { class: "num" }, g.count), h("td", { class: "t" }, fmtTime(g.last_seen))),
      ),
      "No validation failures. Every extracted record matched its schema.",
    ),
  );

  $("#recent-errors").replaceChildren(
    table(
      ["Run", "Target", "Page", "Issues", "Raw record"],
      errs.errors.slice(0, 50).map((e) =>
        h(
          "tr",
          {},
          h("td", { class: "t" }, `#${e.run_id}`, h("div", { class: "muted" }, fmtTime(e.started_at))),
          h("td", {}, targetName(e.target_id)),
          h("td", { class: "wrap mono" }, e.source_url),
          h("td", { class: "wrap" }, h("ul", {}, e.issues.map((i) => h("li", {}, h("span", { class: "mono" }, (i.path || []).join(".") || "(record)"), ": ", i.message)))),
          h("td", { class: "wrap" }, kv(e.raw)),
        ),
      ),
      "No failing records.",
    ),
  );

  const problems = runsRes.runs.flatMap((r) => r.notes.filter((n) => n.level !== "info").map((n) => ({ run: r, note: n })));
  $("#fetch-problems").replaceChildren(
    table(
      ["Run", "Target", "Level", "Problem", "URL"],
      problems.map(({ run, note }) =>
        h("tr", {}, h("td", { class: "t" }, `#${run.id}`, h("div", { class: "muted" }, fmtTime(run.started_at))), h("td", {}, targetName(note.target)), h("td", {}, h("span", { class: `status ${note.level === "error" ? "failed" : "partial"}` }, note.level)), h("td", { class: "wrap" }, note.message), h("td", { class: "wrap mono" }, note.url || "")),
      ),
      "No fetch failures or robots.txt skips in the last 100 runs.",
    ),
  );
}

/* ------------------------------------------------------------------ boot */

const PAGES = { overview: pageOverview, changes: pageChanges, item: pageItem, quality: pageQuality };
document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  for (const a of document.querySelectorAll("header.top nav a")) {
    if (a.dataset.page === page) a.setAttribute("aria-current", "page");
  }
  PAGES[page]?.().catch(showError);
});
