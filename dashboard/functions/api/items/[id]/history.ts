// GET /api/items/:id/history — snapshots over time (e.g. for a price line chart) + field changes
import { badRequest, type Env, ITEM_LABEL_SQL, json } from "../../../../lib/http";

export const onRequestGet: PagesFunction<Env, "id"> = async ({ env, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return badRequest("item id must be a positive integer");

  const [item, snaps, changes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT i.id, i.target_id, i.item_key, i.first_seen, i.last_seen, i.removed_at, i.current_hash,
              ${ITEM_LABEL_SQL} AS label
         FROM items i WHERE i.id = ?`,
    ).bind(id),
    env.DB.prepare(
      "SELECT id, run_id, hash, data_json, captured_at FROM snapshots WHERE item_id = ? ORDER BY captured_at, id",
    ).bind(id),
    env.DB.prepare(
      `SELECT id, run_id, kind, field, old_value, new_value, detected_at
         FROM changes WHERE item_id = ? ORDER BY id DESC`,
    ).bind(id),
  ]);

  if (!item.results[0]) return json({ error: "item not found" }, { status: 404, maxAge: 0 });

  return json({
    item: item.results[0],
    snapshots: (snaps.results as { data_json: string }[]).map(({ data_json, ...s }) => ({
      ...s,
      data: JSON.parse(data_json),
    })),
    changes: changes.results,
  });
};
