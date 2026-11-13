import { describe, expect, it } from "vitest";
import { Book, Quote } from "../worker/src/schemas";

const good = {
  url: "https://books.toscrape.com/catalogue/x_1/index.html",
  title: "  A Title ",
  price: "£51.77",
  in_stock: "In stock (22 available)",
  rating: "Three",
};

describe("Book schema", () => {
  it("normalizes a good record", () => {
    expect(Book.parse(good)).toEqual({
      url: good.url,
      title: "A Title",
      price: 51.77,
      in_stock: true,
      rating: 3,
    });
  });

  it("maps out-of-stock text to false", () => {
    expect(Book.parse({ ...good, in_stock: "Out of stock" }).in_stock).toBe(false);
  });

  it.each([
    ["non-numeric price", { price: "£N/A" }, "price"],
    ["zero price", { price: "£0.00" }, "price"],
    ["unknown rating", { rating: "Zero" }, "rating"],
    ["empty title", { title: "   " }, "title"],
    ["relative url", { url: "x_1/index.html" }, "url"],
  ])("rejects %s", (_name, patch, path) => {
    const r = Book.safeParse({ ...good, ...patch });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path[0])).toContain(path);
  });

  it("is strict about unexpected keys", () => {
    const r = Book.safeParse({ ...good, isbn: "123" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].code).toBe("unrecognized_keys");
  });
});

describe("Quote schema", () => {
  it("sorts and de-duplicates tags, lowercases them", () => {
    const q = Quote.parse({ text: "“Hi.”", author: "A", tags: ["b", "A", "b"] });
    expect(q).toEqual({ text: "Hi.", author: "A", tags: ["a", "b"] });
  });

  it("rejects an empty quote", () => {
    expect(Quote.safeParse({ text: "“”", author: "A", tags: [] }).success).toBe(false);
  });
});
