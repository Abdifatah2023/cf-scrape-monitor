export interface Env {
  DB: D1Database;
  /** Identifying User-Agent sent with every request (plan §8). */
  USER_AGENT: string;
  /** Delay between requests to the same host, in ms. Defaults to 1500. */
  REQUEST_DELAY_MS?: string;
  /** Bearer token for POST /run. Set with `wrangler secret put RUN_TOKEN`. */
  RUN_TOKEN?: string;
  /** Optional: POST a JSON alert here when a run fails or changes exceed the threshold. */
  ALERT_WEBHOOK_URL?: string;
  /** Number of changes in one run that triggers an alert. Defaults to 25. */
  ALERT_CHANGE_THRESHOLD?: string;
}
