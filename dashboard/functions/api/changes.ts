// GET /api/changes?target=&field=&kind=&item=&since=&limit=&before= — change feed, newest first.
// Keyset pagination: pass the returned `next_before` as `before` to get the next page.
import { badRequest, type Env, intParam, isoParam, ITEM_LABEL_SQL, json } from "../../lib/http";

const KINDS = new Set(["added", "updated", "removed"]);

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const limit = intParam(url, "limit", 50, 200);
  const where: string[] = [];
  const args: unknown[] = [];

  const target = url.searchParams.get("target");
  if (target) {
    where.push("i.target_id = ?");
    args.push(target);
  }
  const field = url.searchParams.get("field");
  if (field) {
    where.push("c.field = ?");
    args.push(field);
  }
  const kind = url.searchParams.get("kind");
  if (kind) {
    if (!KINDS.has(kind)) return badRequest("'kind' must be added, updated or removed");
    where.push("c.kind = ?");
    args.push(kind);
  }
  const item = url.searchParams.get("item");
  if (item) {
    where.push("c.item_id = ?");
    args.push(Number(item));
  }
  const since = isoParam(url, "since");
  if (since instanceof Error) return badRequest(since.message);
  if (since) {
    where.push("c.detected_at >= ?");
    args.push(since);
  }
  const before = url.searchParams.get("before");
  if (before) {
    where.push("c.id < ?");
    args.push(Number(before));
  }

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.run_id, c.kind, c.field, c.old_value, c.new_value, c.detected_at,
            i.id AS item_id, i.target_id, i.item_key, ${ITEM_LABEL_SQL} AS item_label
       FROM changes c JOIN items i ON i.id = c.item_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY c.id DESC LIMIT ?`,
  )
    .bind(...args, limit + 1)
    .all<{ id: number }>();

  const page = results.slice(0, limit);
  return json({
    changes: page,
    next_before: results.length > limit ? page[page.length - 1].id : null,
  });
};
