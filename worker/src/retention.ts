// Retention job (plan §4.4): keep D1 small. Runs on its own daily cron.
//  - snapshots older than RETENTION_DAYS are deleted, but the latest snapshot
//    of every item is always kept (it's the baseline for the next diff)
//  - validation_errors from runs older than RETENTION_DAYS are deleted
// `changes` and `runs` are tiny and are kept as the long-term history.

export const RETENTION_DAYS = 90;

export interface RetentionResult {
  cutoff: string;
  snapshotsDeleted: number;
  validationErrorsDeleted: number;
}

export async function runRetention(db: D1Database, now = new Date(), days = RETENTION_DAYS): Promise<RetentionResult> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const [snaps, errs] = await db.batch([
    db
      .prepare(
        `DELETE FROM snapshots
          WHERE captured_at < ?
            AND id NOT IN (SELECT MAX(id) FROM snapshots GROUP BY item_id)`,
      )
      .bind(cutoff),
    db
      .prepare("DELETE FROM validation_errors WHERE run_id IN (SELECT id FROM runs WHERE started_at < ?)")
      .bind(cutoff),
  ]);
  const result = {
    cutoff,
    snapshotsDeleted: snaps.meta.changes ?? 0,
    validationErrorsDeleted: errs.meta.changes ?? 0,
  };
  console.log(`retention: ${JSON.stringify(result)}`);
  return result;
}
