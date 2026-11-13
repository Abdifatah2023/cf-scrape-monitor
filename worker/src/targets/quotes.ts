import { decodeEntities, rewrite, squash } from "../html";
import { Quote } from "../schemas";
import type { RawRecord, Target } from "./types";

const BASE = "https://quotes.toscrape.com";

interface RawQuote {
  text: string;
  author: string;
  tags: string[];
}

/** Extract every `div.quote` on a quotes page. */
export async function extractQuotes(html: string, _pageUrl: string): Promise<RawRecord[]> {
  const quotes: RawQuote[] = [];
  let cur: RawQuote | null = null;

  const rewriter = new HTMLRewriter()
    .on("div.quote", {
      element() {
        cur = { text: "", author: "", tags: [] };
        quotes.push(cur);
      },
    })
    .on("div.quote span.text", {
      text(t) {
        if (cur) cur.text += t.text;
      },
    })
    .on("div.quote small.author", {
      text(t) {
        if (cur) cur.author += t.text;
      },
    })
    .on("div.quote a.tag", {
      // start a new tag on each <a class="tag">, then append its text chunks
      element() {
        if (cur) cur.tags.push("");
      },
      text(t) {
        if (cur && cur.tags.length) cur.tags[cur.tags.length - 1] += t.text;
      },
    });

  await rewrite(html, rewriter);

  return quotes.map((q) => ({
    text: squash(decodeEntities(q.text)),
    author: squash(decodeEntities(q.author)),
    tags: q.tags.map((t) => squash(decodeEntities(t))),
  }));
}

export const quotes: Target = {
  id: "quotes",
  name: "Quotes to Scrape",
  baseUrl: BASE,
  pages: [`${BASE}/`], // first page only (plan §1)
  extract: extractQuotes,
  schema: Quote,
  // quotes have no URL of their own; author + text is the natural key
  keyOf: (r) => `${String(r.author)}: ${String(r.text)}`,
};
