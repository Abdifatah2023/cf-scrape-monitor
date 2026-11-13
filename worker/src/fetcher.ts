// Polite HTTP fetching (plan §4.2 steps 1–2, §8):
// - robots.txt checked first, cached 24 h in D1
// - one request at a time, with a delay between requests to the same host
// - conditional requests (If-None-Match / If-Modified-Since) from fetch_cache
// - 10 s timeout, one retry with backoff on 5xx / 429 / network error, honoring Retry-After
// - identifying User-Agent on every request

import type { Env } from "./env";
import { isAllowed, productToken } from "./robots";

export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
};

export type PageResult =
  | { kind: "ok"; url: string; status: number; html: string }
  | { kind: "not_modified"; url: string }
  | { kind: "disallowed"; url: string; reason: string };

export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 10_000;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MS = 2_000;
const MAX_RETRY_WAIT_MS = 60_000;

/** Parse Retry-After (delta-seconds or HTTP-date) into milliseconds. */
export function retryAfterMs(header: string | null, now: Date): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
}

export class PoliteFetcher {
  private lastRequestAt = new Map<string, number>();
  private robots = new Map<string, string | null>(); // origin → body (null = unreachable)
  readonly delayMs: number;
  /** Number of HTTP requests actually sent (robots + pages + retries). */
  requests = 0;

  constructor(
    private env: Env,
    private deps: Deps = defaultDeps,
  ) {
    const d = Number(env.REQUEST_DELAY_MS ?? "1500");
    this.delayMs = Number.isFinite(d) && d >= 0 ? d : 1500;
  }

  /** Fetch a page politely. Throws FetchError when it can't get a usable answer. */
  async get(url: string): Promise<PageResult> {
    const u = new URL(url);

    const robotsBody = await this.robotsFor(u.origin);
    if (robotsBody === null) {
      return { kind: "disallowed", url, reason: "robots.txt unreachable (server error); skipping to be safe" };
    }
    if (!isAllowed(robotsBody, productToken(this.env.USER_AGENT), u.pathname + u.search)) {
      return { kind: "disallowed", url, reason: `disallowed by ${u.origin}/robots.txt` };
    }

    const cached = await this.env.DB.prepare(
      "SELECT etag, last_modified FROM fetch_cache WHERE url = ?",
    )
      .bind(url)
      .first<{ etag: string | null; last_modified: string | null }>();

    const headers: Record<string, string> = { accept: "text/html" };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.last_modified) headers["if-modified-since"] = cached.last_modified;

    const res = await this.request(url, headers);

    if (res.status === 304) {
      await this.saveCache(url, cached?.etag ?? null, cached?.last_modified ?? null, 304);
      return { kind: "not_modified", url };
    }
    if (!res.ok) {
      await this.saveCache(url, cached?.etag ?? null, cached?.last_modified ?? null, res.status);
      throw new FetchError(`HTTP ${res.status}`, url, res.status);
    }

    const html = await res.text();
    await this.saveCache(url, res.headers.get("etag"), res.headers.get("last-modified"), res.status);
    return { kind: "ok", url, status: res.status, html };
  }

  /** Forget stored validators so the next get() is unconditional. */
  async clearCache(url: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM fetch_cache WHERE url = ?").bind(url).run();
  }

  // ---- internals ---------------------------------------------------------

  private async saveCache(url: string, etag: string | null, lastModified: string | null, status: number) {
    await this.env.DB.prepare(
      `INSERT INTO fetch_cache (url, etag, last_modified, last_status, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
         last_status = excluded.last_status, fetched_at = excluded.fetched_at`,
    )
      .bind(url, etag, lastModified, status, this.deps.now().toISOString())
      .run();
  }

  /** robots.txt body for an origin ('' = no robots.txt), or null if it couldn't be read. */
  private async robotsFor(origin: string): Promise<string | null> {
    if (this.robots.has(origin)) return this.robots.get(origin)!;

    const row = await this.env.DB.prepare("SELECT body, fetched_at FROM robots_cache WHERE origin = ?")
      .bind(origin)
      .first<{ body: string; fetched_at: string }>();
    if (row && this.deps.now().getTime() - Date.parse(row.fetched_at) < ROBOTS_TTL_MS) {
      this.robots.set(origin, row.body);
      return row.body;
    }

    let body: string | null;
    let status = 0;
    try {
      const res = await this.request(`${origin}/robots.txt`, { accept: "text/plain" });
      status = res.status;
      if (res.ok) body = await res.text();
      else if (res.status >= 400 && res.status < 500) body = ""; // no robots.txt → everything allowed
      else body = null; // 5xx → treat as temporarily disallowed
    } catch {
      body = null;
    }

    this.robots.set(origin, body);
    if (body !== null) {
      await this.env.DB.prepare(
        `INSERT INTO robots_cache (origin, status, body, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(origin) DO UPDATE SET status = excluded.status, body = excluded.body,
           fetched_at = excluded.fetched_at`,
      )
        .bind(origin, status, body, this.deps.now().toISOString())
        .run();
    }
    return body;
  }

  /** Wait until `delayMs` has passed since the last request to this host. */
  private async throttle(host: string) {
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + this.delayMs - this.deps.now().getTime();
      if (wait > 0) await this.deps.sleep(wait);
    }
    this.lastRequestAt.set(host, this.deps.now().getTime());
  }

  /** One request, plus at most one retry on 5xx / 429 / network error. */
  private async request(url: string, headers: Record<string, string>): Promise<Response> {
    const host = new URL(url).host;
    for (let attempt = 1; ; attempt++) {
      await this.throttle(host);
      this.requests++;
      let res: Response;
      try {
        res = await this.deps.fetch(url, {
          headers: { "user-agent": this.env.USER_AGENT, ...headers },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: "follow",
        });
      } catch (err) {
        const msg = err instanceof Error && err.name === "TimeoutError" ? "timed out after 10 s" : String(err);
        if (attempt >= 2) throw new FetchError(msg, url);
        await this.deps.sleep(BACKOFF_MS * attempt);
        continue;
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 2) return res;

      const wait = retryAfterMs(res.headers.get("retry-after"), this.deps.now()) ?? BACKOFF_MS * attempt;
      if (wait > MAX_RETRY_WAIT_MS) return res; // server asked us to stay away longer; give up politely
      await res.body?.cancel();
      await this.deps.sleep(wait);
    }
  }
}
