// Optional alerting (plan §6, milestone 8): POST to a webhook when a run
// fails / is partial, or when it finds more changes than a threshold.
// The body has a `text` field, so Slack/Discord-style incoming webhooks render it directly.

import type { Env } from "./env";
import type { RunSummary } from "./pipeline";

export const DEFAULT_CHANGE_THRESHOLD = 25;

export function alertReasons(summary: RunSummary, threshold: number): string[] {
  const reasons: string[] = [];
  if (summary.status !== "ok") {
    const failed = summary.targets.filter((t) => !t.ok).map((t) => t.target);
    reasons.push(`run ${summary.status}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}`);
  }
  if (summary.changesFound >= threshold) {
    reasons.push(`${summary.changesFound} changes (threshold ${threshold})`);
  }
  return reasons;
}

/** Returns true if an alert was sent. Never throws: alerting must not break a run. */
export async function maybeAlert(
  env: Env,
  summary: RunSummary,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  if (!env.ALERT_WEBHOOK_URL) return false;
  const threshold = Number(env.ALERT_CHANGE_THRESHOLD ?? DEFAULT_CHANGE_THRESHOLD) || DEFAULT_CHANGE_THRESHOLD;
  const reasons = alertReasons(summary, threshold);
  if (!reasons.length) return false;

  const problems = summary.notes.filter((n) => n.level === "error").map((n) => `• ${n.target}: ${n.message}${n.url ? ` (${n.url})` : ""}`);
  const text = [`cf-scrape-monitor run #${summary.runId}: ${reasons.join("; ")}`, ...problems.slice(0, 10)].join("\n");

  try {
    const res = await fetcher(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, run: summary }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`alert webhook returned HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error("alert webhook failed", err);
    return false;
  }
}
