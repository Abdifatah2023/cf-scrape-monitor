import type { Env } from "./env";

export default {
  // Temporary health check: lists targets from D1. Replaced in later milestones.
  async fetch(_req, env): Promise<Response> {
    const { results } = await env.DB.prepare(
      "SELECT id, name, base_url, enabled FROM targets ORDER BY id"
    ).all();
    return Response.json({ ok: true, targets: results });
  },

  async scheduled(event, _env, _ctx): Promise<void> {
    console.log(`cron fired: ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);
  },
} satisfies ExportedHandler<Env>;