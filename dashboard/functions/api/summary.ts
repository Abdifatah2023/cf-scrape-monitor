// GET /api/summary — last run, status, totals, changes in the last 24 h / 7 d
import { type Env, isoHoursAgo, json, parseNotes } from "../../lib/http";

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const day = isoHoursAgo(24);
  const week = isoHoursAgo(24 * 7);

  const [lastRun, totals, runs7d, perTarget] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1"),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM items WHERE removed_at IS NULL)              AS items_tracked,
         (SELECT COUNT(*) FROM items WHERE removed_at IS NOT NULL)          AS items_removed,
         (SELECT COUNT(*) FROM snapshots)                                   AS snapshots,
         (SELECT COUNT(*) FROM runs)                                        AS runs,
         (SELECT COUNT(*) FROM changes WHERE detected_at >= ?1)             AS changes_24h,
         (SELECT COUNT(*) FROM changes WHERE detected_at >= ?2)             AS changes_7d,
         (SELECT COUNT(*) FROM validation_errors v JOIN runs r ON r.id = v.run_id
            WHERE r.started_at >= ?2)                                       AS validation_errors_7d`,
    ).bind(day, week),
    env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM runs
        WHERE started_at >= ? AND finished_at IS NOT NULL GROUP BY status`,
    ).bind(week),
    env.DB.prepare(
      `SELECT t.id, t.name, t.base_url, t.enabled,
              (SELECT COUNT(*) FROM items i WHERE i.target_id = t.id AND i.removed_at IS NULL) AS items,
              (SELECT MAX(c.detected_at) FROM changes c JOIN items i ON i.id = c.item_id
                 WHERE i.target_id = t.id AND c.kind <> 'added')                               AS last_change
         FROM targets t ORDER BY t.id`,
    ),
  ]);

  const statusCounts = Object.fromEntries(
    (runs7d.results as { status: string; n: number }[]).map((r) => [r.status, r.n]),
  ) as Record<string, number>;
  const finished7d = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  const last = lastRun.results[0] as { notes?: string | null } | undefined;
  return json({
    last_run: last ? parseNotes(last) : null,
    totals: totals.results[0],
    runs_7d: { total: finished7d, by_status: statusCounts },
    success_rate_7d: finished7d ? (statusCounts.ok ?? 0) / finished7d : null,
    targets: perTarget.results,
    generated_at: new Date().toISOString(),
  });
};
