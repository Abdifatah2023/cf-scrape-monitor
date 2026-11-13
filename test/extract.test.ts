import { describe, expect, it } from "vitest";
import { extractBooks } from "../worker/src/targets/books";
import { extractQuotes } from "../worker/src/targets/quotes";
import { decodeEntities } from "../worker/src/html";
import { Book, Quote } from "../worker/src/schemas";
import { PAGE } from "./helpers";

import page1 from "./fixtures/books-page-1.html?raw";
import page2 from "./fixtures/books-page-2.html?raw";
import page3 from "./fixtures/books-page-3.html?raw";
import quotesPage from "./fixtures/quotes-page-1.html?raw";

describe("books extractor", () => {
  it("extracts 20 raw records per catalogue page, all strings", async () => {
    for (const [n, html] of [[1, page1], [2, page2], [3, page3]] as const) {
      const recs = await extractBooks(html, PAGE(n));
      expect(recs).toHaveLength(20);
      for (const r of recs) for (const v of Object.values(r)) expect(typeof v).toBe("string");
    }
  });

  it("reads the full title, absolute url, price, stock and rating word", async () => {
    const [first] = await extractBooks(page1, PAGE(1));
    expect(first).toEqual({
      url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
      title: "A Light in the Attic",
      price: "£51.77",
      in_stock: "In stock",
      rating: "Three",
    });
  });

  it("decodes HTML entities in titles", async () => {
    const all = [...(await extractBooks(page1, PAGE(1))), ...(await extractBooks(page2, PAGE(2)))];
    expect(all.some((r) => String(r.title).includes("'"))).toBe(true);
    expect(all.some((r) => String(r.title).includes("&#39;"))).toBe(false);
  });

  it("every real record passes the Book schema", async () => {
    const recs = await extractBooks(page3, PAGE(3));
    for (const r of recs) expect(Book.safeParse(r).success).toBe(true);
  });

  it("returns no records for malformed / unrelated HTML", async () => {
    expect(await extractBooks("<html><body><div>maintenance</div", PAGE(1))).toEqual([]);
  });
});

describe("quotes extractor", () => {
  it("extracts 10 quotes with author and tags", async () => {
    const recs = await extractQuotes(quotesPage, "https://quotes.toscrape.com/");
    expect(recs).toHaveLength(10);
    expect(recs[0].author).toBe("Albert Einstein");
    expect(recs[0].tags).toEqual(["change", "deep-thoughts", "thinking", "world"]);
    for (const r of recs) expect(Quote.safeParse(r).success).toBe(true);
  });

  it("normalizes text: strips curly quotes", async () => {
    const [first] = await extractQuotes(quotesPage, "https://quotes.toscrape.com/");
    const q = Quote.parse(first);
    expect(q.text.startsWith("The world as we have created it")).toBe(true);
    expect(q.text.endsWith("thinking.")).toBe(true);
  });
});

describe("decodeEntities", () => {
  it("handles named, decimal and hex entities", () => {
    expect(decodeEntities("Tom &amp; Jerry&#39;s &#x2014; &lt;b&gt; &unknown;")).toBe("Tom & Jerry's — <b> &unknown;");
  });
});
