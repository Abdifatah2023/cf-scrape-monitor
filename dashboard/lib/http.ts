// Shared helpers for the read-only dashboard API.

export interface Env {
  DB: D1Database;
}

/** JSON response, cached briefly at the edge and in the browser (plan §5). */
export function json(data: unknown, init: { status?: number; maxAge?: number } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${init.maxAge ?? 60}`,
    },
  });
}

export function badRequest(message: string): Response {
  return json({ error: message }, { status: 400, maxAge: 0 });
}

/** Parse a positive integer query param, clamped to [1, max]. */
export function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  const n = raw === null ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** ISO date/time (or date) param, or null. Rejects anything else. */
export function isoParam(url: URL, name: string): string | null | Error {
  const raw = url.searchParams.get(name);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    return new Error(`'${name}' must be an ISO date, e.g. 2026-11-01 or 2026-11-01T00:00:00Z`);
  }
  return raw;
}

export function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

/** SQL expression for a human label of an item, from its latest snapshot. Needs alias `i` for items. */
export const ITEM_LABEL_SQL = `COALESCE(
  (SELECT COALESCE(json_extract(s.data_json, '$.title'), json_extract(s.data_json, '$.text'))
     FROM snapshots s WHERE s.item_id = i.id ORDER BY s.id DESC LIMIT 1),
  i.item_key)`;

export function parseNotes<T extends { notes?: string | null }>(row: T): Omit<T, "notes"> & { notes: unknown[] } {
  let notes: unknown[] = [];
  if (row.notes) {
    try {
      notes = JSON.parse(row.notes);
    } catch {
      notes = [];
    }
  }
  return { ...row, notes };
}
