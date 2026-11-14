// Cron expressions from wrangler.toml; scheduled() dispatches on event.cron.
// Kept out of index.ts: the Workers runtime treats every named export of the
// main module as an entrypoint, so it may only export handlers/classes.
export const CRON_SCRAPE = "17 */6 * * *";
export const CRON_RETENTION = "43 3 * * *";
