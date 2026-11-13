import { env } from "cloudflare:test";
import type { Deps } from "../worker/src/fetcher";

import page1 from "./fixtures/books-page-1.html?raw";
import page2 from "./fixtures/books-page-2.html?raw";
import page3 from "./fixtures/books-page-3.html?raw";

export const BOOKS = "https://books.toscrape.com";
export const PAGE = (n: number) => `${BOOKS}/catalogue/page-${n}.html`;
export const BOOK_PAGES: Record<string, string> = { [PAGE(1)]: page1, [PAGE(2)]: page2, [PAGE(3)]: page3 };

type Handler = (req: { url: string; headers: Record<string, string> }) => Response | Promise<Response>;

export interface FakeNet {
  deps: Deps;
  /** Every request made, in order. */
  calls: { url: string; headers: Record<string, string> }[];
  sleeps: number[];
  /** Replace the handler for a URL (default: robots 404, book pages from fixtures). */
  route(url: string, handler: Handler | string): void;
}

/** A mocked network: fetch() is served from fixtures, sleep() is instant but recorded. */
export function fakeNet(): FakeNet {
  const routes = new Map<string, Handler>();
  routes.set(`${BOOKS}/robots.txt`, () => new Response("not found", { status: 404 }));
  for (const [url, html] of Object.entries(BOOK_PAGES)) routes.set(url, () => html200(html));

  const net: FakeNet = {
    calls: [],
    sleeps: [],
    route(url, handler) {
      routes.set(url, typeof handler === "string" ? () => html200(handler) : handler);
    },
    deps: {
      now: () => new Date(),
      sleep: async (ms) => {
        net.sleeps.push(ms);
      },
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const req = { url, headers };
        net.calls.push(req);
        const h = routes.get(url);
        if (!h) return new Response("no route in fake network", { status: 404 });
        return h(req);
      },
    },
  };
  return net;
}

export function html200(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html", ...headers } });
}

export async function count(table: string, where = "1=1"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>();
  return row!.n;
}

/** Empty all data tables (keeps the seeded `targets`). */
export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["changes", "snapshots", "validation_errors", "items", "runs", "fetch_cache", "robots_cache"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}
