// Diff validated records against D1 and write only what changed (plan §4.2 step 6).

import { diffFields } from "./hash";
import type { CleanRecord } from "./targets/types";

export interface ValidRecord {
  key: string;
  hash: string;
  data: CleanRecord;
}

export interface PersistResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  snapshots: number;
  changeRows: number;
}

interface ItemRow {
  id: number;
  item_key: string;
  current_hash: string;
  removed_at: string | null;
}

const BATCH_SIZE = 50;

export async function runBatches(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE));
  }
}

/**
 * - new key            → items + snapshots + changes(kind='added')
 * - hash differs       → snapshots + one changes row per changed field
 * - same hash          → only items.last_seen is bumped
 * - missing this run   → changes(kind='removed'), only when `allowRemovals`
 *                        (i.e. every page of the target fetched and parsed cleanly)
 */
export async function persistTarget(
  db: D1Database,
  opts: { targetId: string; runId: number; now: string; records: ValidRecord[]; allowRemovals: boolean },
): Promise<PersistResult> {
  const { targetId, runId, now, records, allowRemovals } = opts;
  const result: PersistResult = { added: 0, updated: 0, removed: 0, unchanged: 0, snapshots: 0, changeRows: 0 };

  const { results: rows } = await db
    .prepare("SELECT id, item_key, current_hash, removed_at FROM items WHERE target_id = ?")
    .bind(targetId)
    .all<ItemRow>();
  const existing = new Map(rows.map((r) => [r.item_key, r]));

  // the same item can appear twice (e.g. on two pages); keep the first
  const seen = new Map<string, ValidRecord>();
  for (const r of records) if (!seen.has(r.key)) seen.set(r.key, r);

  // previous data for items whose hash changed, so we can diff field by field
  const changed = [...seen.values()]
    .map((r) => ({ rec: r, row: existing.get(r.key) }))
    .filter((x): x is { rec: ValidRecord; row: ItemRow } => !!x.row && x.row.current_hash !== x.rec.hash);
  const previous = new Map<number, CleanRecord>();
  for (let i = 0; i < changed.length; i += BATCH_SIZE) {
    const chunk = changed.slice(i, i + BATCH_SIZE);
    const res = await db.batch<{ data_json: string }>(
      chunk.map(({ row }) =>
        db.prepare("SELECT data_json FROM snapshots WHERE item_id = ? ORDER BY id DESC LIMIT 1").bind(row.id),
      ),
    );
    res.forEach((r, j) => {
      const json = r.results[0]?.data_json;
      previous.set(chunk[j].row.id, json ? JSON.parse(json) : {});
    });
  }

  const stmts: D1PreparedStatement[] = [];
  const insertSnapshot = (itemId: number | null, rec: ValidRecord) => {
    result.snapshots++;
    stmts.push(
      itemId !== null
        ? db
            .prepare("INSERT INTO snapshots (item_id, run_id, hash, data_json, captured_at) VALUES (?, ?, ?, ?, ?)")
            .bind(itemId, runId, rec.hash, JSON.stringify(rec.data), now)
        : db
            .prepare(
              `INSERT INTO snapshots (item_id, run_id, hash, data_json, captured_at)
               SELECT id, ?, ?, ?, ? FROM items WHERE target_id = ? AND item_key = ?`,
            )
            .bind(runId, rec.hash, JSON.stringify(rec.data), now, targetId, rec.key),
    );
  };
  const insertChange = (
    itemId: number | null,
    key: string,
    kind: "added" | "updated" | "removed",
    field: string | null,
    oldV: string | null,
    newV: string | null,
  ) => {
    result.changeRows++;
    stmts.push(
      itemId !== null
        ? db
            .prepare(
              `INSERT INTO changes (item_id, run_id, kind, field, old_value, new_value, detected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(itemId, runId, kind, field, oldV, newV, now)
        : db
            .prepare(
              `INSERT INTO changes (item_id, run_id, kind, field, old_value, new_value, detected_at)
               SELECT id, ?, ?, ?, ?, ?, ? FROM items WHERE target_id = ? AND item_key = ?`,
            )
            .bind(runId, kind, field, oldV, newV, now, targetId, key),
    );
  };

  for (const rec of seen.values()) {
    const row = existing.get(rec.key);

    if (!row) {
      result.added++;
      stmts.push(
        db
          .prepare(
            `INSERT INTO items (target_id, item_key, first_seen, last_seen, current_hash)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(targetId, rec.key, now, now, rec.hash),
      );
      insertSnapshot(null, rec);
      insertChange(null, rec.key, "added", null, null, null);
      continue;
    }

    if (row.removed_at) {
      // it was reported removed earlier and is back
      result.added++;
      insertChange(row.id, rec.key, "added", null, null, null);
    }

    if (row.current_hash !== rec.hash) {
      result.updated++;
      insertSnapshot(row.id, rec);
      for (const d of diffFields(previous.get(row.id) ?? {}, rec.data)) {
        insertChange(row.id, rec.key, "updated", d.field, d.old_value, d.new_value);
      }
      stmts.push(
        db
          .prepare("UPDATE items SET current_hash = ?, last_seen = ?, removed_at = NULL WHERE id = ?")
          .bind(rec.hash, now, row.id),
      );
    } else {
      if (!row.removed_at) result.unchanged++;
      stmts.push(db.prepare("UPDATE items SET last_seen = ?, removed_at = NULL WHERE id = ?").bind(now, row.id));
    }
  }

  if (allowRemovals) {
    for (const row of existing.values()) {
      if (seen.has(row.item_key) || row.removed_at) continue;
      result.removed++;
      insertChange(row.id, row.item_key, "removed", null, null, null);
      stmts.push(db.prepare("UPDATE items SET removed_at = ? WHERE id = ?").bind(now, row.id));
    }
  }

  await runBatches(db, stmts);
  return result;
}
