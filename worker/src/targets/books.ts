import { decodeEntities, rewrite, squash } from "../html";
import { Book } from "../schemas";
import type { RawRecord, Target } from "./types";

const BASE = "https://books.toscrape.com";

interface RawBook {
  url: string;
  title: string;
  price: string;
  in_stock: string;
  rating: string;
}

/** Extract every `article.product_pod` on a catalogue listing page. */
export async function extractBooks(html: string, pageUrl: string): Promise<RawRecord[]> {
  const books: RawBook[] = [];
  let cur: RawBook | null = null;

  const rewriter = new HTMLRewriter()
    .on("article.product_pod", {
      element() {
        cur = { url: "", title: "", price: "", in_stock: "", rating: "" };
        books.push(cur);
      },
    })
    .on("article.product_pod h3 a", {
      element(el) {
        if (!cur) return;
        const href = el.getAttribute("href") ?? "";
        cur.url = href ? new URL(decodeEntities(href), pageUrl).toString() : "";
        // the visible link text is truncated ("A Light in the ..."); the title attribute is not
        cur.title = decodeEntities(el.getAttribute("title") ?? "");
      },
    })
    .on("article.product_pod p.star-rating", {
      element(el) {
        if (!cur) return;
        const cls = (el.getAttribute("class") ?? "").split(/\s+/);
        cur.rating = cls.find((c) => c !== "star-rating" && c !== "") ?? "";
      },
    })
    .on("article.product_pod p.price_color", {
      text(t) {
        if (cur) cur.price += t.text;
      },
    })
    .on("article.product_pod p.availability", {
      text(t) {
        if (cur) cur.in_stock += t.text;
      },
    });

  await rewrite(html, rewriter);

  return books.map((b) => ({
    ...b,
    price: squash(decodeEntities(b.price)),
    in_stock: squash(decodeEntities(b.in_stock)),
  }));
}

export const books: Target = {
  id: "books",
  name: "Books to Scrape",
  baseUrl: BASE,
  // 3 catalogue pages = 60 books (plan §1)
  pages: [1, 2, 3].map((n) => `${BASE}/catalogue/page-${n}.html`),
  extract: extractBooks,
  schema: Book,
  keyOf: (r) => String(r.url),
};
