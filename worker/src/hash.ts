// Canonical hashing and field-level diffs (plan §4.2 steps 5–6).

/** Fields that describe *where/when* a record came from, not *what* it is. */
export const PROVENANCE_FIELDS = new Set(["source_url"]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** JSON with sorted keys at every level and provenance fields removed from the top level. */
export function canonicalJson(record: Record<string, unknown>): string {
  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!PROVENANCE_FIELDS.has(k)) content[k] = v;
  }
  return JSON.stringify(canonicalize(content));
}

/** SHA-256 hex digest of the canonical JSON. */
export async function hashRecord(record: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(record));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface FieldChange {
  field: string;
  old_value: string | null;
  new_value: string | null;
}

/** How a value is written into the TEXT columns of `changes`. */
export function displayValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(canonicalize(v));
}

/** One entry per content field whose value differs (provenance ignored). */
export function diffFields(
  oldRec: Record<string, unknown>,
  newRec: Record<string, unknown>,
): FieldChange[] {
  const fields = new Set([...Object.keys(oldRec), ...Object.keys(newRec)]);
  const out: FieldChange[] = [];
  for (const field of [...fields].sort()) {
    if (PROVENANCE_FIELDS.has(field)) continue;
    const a = displayValue(oldRec[field]);
    const b = displayValue(newRec[field]);
    if (a !== b) out.push({ field, old_value: a, new_value: b });
  }
  return out;
}
