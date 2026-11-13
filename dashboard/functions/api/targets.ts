// GET /api/targets — configured targets with item counts
import { type Env, json } from "../../lib/http";

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.name, t.base_url, t.enabled, t.created_at,
            (SELECT COUNT(*) FROM items i WHERE i.target_id = t.id AND i.removed_at IS NULL) AS items,
            (SELECT COUNT(*) FROM items i WHERE i.target_id = t.id AND i.removed_at IS NOT NULL) AS removed
       FROM targets t ORDER BY t.id`,
  ).all();
  return json({ targets: results });
};
