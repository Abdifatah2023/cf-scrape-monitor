import { maybeAlert } from "./alert";
import type { Env } from "./env";
import { runPipeline } from "./pipeline";
import { runRetention } from "./retention";

/** Cron expressions from wrangler.toml; scheduled() dispatches on event.cron. */
export const CRON_SCRAPE = "17 */6 * * *";
export const CRON_RETENTION = "43 3 * * *";

/** Constant-time string comparison for the bearer token. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);

    // POST /run — manual trigger, protected by RUN_TOKEN (plan §4.3)
    if (url.pathname === "/run") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
      if (!env.RUN_TOKEN) return new Response("RUN_TOKEN is not configured", { status: 503 });
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!safeEqual(token, env.RUN_TOKEN)) return new Response("Unauthorized", { status: 401 });

      const summary = await runPipeline(env, "manual");
      ctx.waitUntil(maybeAlert(env, summary));
      return Response.json(summary);
    }

    if (url.pathname === "/") {
      return new Response("cf-scrape-monitor scraper. Data is served by the dashboard.\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx): Promise<void> {
    console.log(`cron fired: ${event.cron}`);
    if (event.cron === CRON_RETENTION) {
      ctx.waitUntil(runRetention(env.DB));
      return;
    }
    // CRON_SCRAPE (and anything unexpected) scrapes
    ctx.waitUntil(runPipeline(env, "cron").then((summary) => maybeAlert(env, summary)));
  },
} satisfies ExportedHandler<Env>;
