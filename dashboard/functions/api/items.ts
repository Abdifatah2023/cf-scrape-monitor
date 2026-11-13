// GET /api/items?target=&q=&limit= — tracked items with their current data (for browsing)
import { type Env, intParam, ITEM_LABEL_SQL, json } from "../../lib/http";

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const limit = intParam(url, "limit", 100, 500);
  const where: string[] = [];
  const args: unknown[] = [];

  const target = url.searchParams.get("target");
  if (target) {
    where.push("i.target_id = ?");
    args.push(target);
  }

  const { results } = await env.DB.prepare(
    `SELECT i.id, i.target_id, i.item_key, i.first_seen, i.last_seen, i.removed_at,
            ${ITEM_LABEL_SQL} AS label,
            (SELECT COUNT(*) FROM snapshots s WHERE s.item_id = i.id) AS snapshots,
            (SELECT COUNT(*) FROM changes c WHERE c.item_id = i.id AND c.kind = 'updated') AS updates
       FROM items i
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY updates DESC, label
       LIMIT ?`,
  )
    .bind(...args, limit)
    .all<{ label: string }>();

  const q = url.searchParams.get("q")?.toLowerCase();
  return json({ items: q ? results.filter((r) => String(r.label).toLowerCase().includes(q)) : results });
};
