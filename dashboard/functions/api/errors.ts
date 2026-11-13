// GET /api/errors?run=&target=&limit= — validation failures with their Zod issues,
// plus the same failures grouped by target + field + issue for the data-quality view.
import { type Env, intParam, json } from "../../lib/http";

interface Row {
  id: number;
  run_id: number;
  target_id: string;
  source_url: string;
  issues_json: string;
  raw_json: string | null;
  started_at: string;
}

interface Issue {
  code?: string;
  path?: (string | number)[];
  message?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const limit = intParam(url, "limit", 200, 1000);
  const where: string[] = [];
  const args: unknown[] = [];

  const run = url.searchParams.get("run");
  if (run) {
    where.push("v.run_id = ?");
    args.push(Number(run));
  }
  const target = url.searchParams.get("target");
  if (target) {
    where.push("v.target_id = ?");
    args.push(target);
  }

  const { results } = await env.DB.prepare(
    `SELECT v.id, v.run_id, v.target_id, v.source_url, v.issues_json, v.raw_json, r.started_at
       FROM validation_errors v JOIN runs r ON r.id = v.run_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY v.id DESC LIMIT ?`,
  )
    .bind(...args, limit)
    .all<Row>();

  const errors = results.map(({ issues_json, raw_json, ...r }) => ({
    ...r,
    issues: safeParse<Issue[]>(issues_json, []),
    raw: raw_json ? safeParse<unknown>(raw_json, raw_json) : null,
  }));

  // group: target × field × code × message
  const groups = new Map<string, { target_id: string; field: string; code: string; message: string; count: number; last_seen: string; last_url: string }>();
  for (const e of errors) {
    for (const issue of e.issues) {
      const field = issue.path?.length ? issue.path.join(".") : "(record)";
      const code = issue.code ?? "unknown";
      const message = issue.message ?? "";
      const key = [e.target_id, field, code, message].join("\u0000");
      const g = groups.get(key);
      if (g) {
        g.count++;
        if (e.started_at > g.last_seen) {
          g.last_seen = e.started_at;
          g.last_url = e.source_url;
        }
      } else {
        groups.set(key, { target_id: e.target_id, field, code, message, count: 1, last_seen: e.started_at, last_url: e.source_url });
      }
    }
  }

  return json({
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    errors,
  });
};

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
