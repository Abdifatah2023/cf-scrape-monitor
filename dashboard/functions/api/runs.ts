// GET /api/runs?limit=50 — run history, newest first (for the health chart)
import { type Env, intParam, json, parseNotes } from "../../lib/http";

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const limit = intParam(url, "limit", 50, 500);

  const { results } = await env.DB.prepare(
    `SELECT id, started_at, finished_at, trigger, status, pages_fetched, records_valid,
            records_invalid, changes_found, notes
       FROM runs ORDER BY id DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{ notes: string | null }>();

  return json({ runs: results.map(parseNotes) });
};
