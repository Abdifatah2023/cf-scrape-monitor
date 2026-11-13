import { z } from "zod";

// Raw records coming out of the extractors are all strings (plan §4.2 step 3).
// These schemas normalize and validate them (step 4). `.strict()` rejects any
// unexpected key, so an extractor bug that adds or renames a field is caught.

const RATINGS = ["One", "Two", "Three", "Four", "Five"] as const;

export const Book = z
  .object({
    url: z.url(),
    title: z.string().trim().min(1),
    price: z
      .string()
      .transform((s) => Number(s.replace(/[^0-9.]/g, "")))
      .pipe(z.number().positive()),
    in_stock: z.string().transform((s) => /in stock/i.test(s)),
    rating: z.enum(RATINGS).transform((r) => RATINGS.indexOf(r) + 1),
  })
  .strict();

export const Quote = z
  .object({
    text: z
      .string()
      // strip the decorative curly quotes the site wraps every quote in
      .transform((s) => s.trim().replace(/^[“"]+|[”"]+$/g, "").trim())
      .pipe(z.string().min(1)),
    author: z.string().trim().min(1),
    tags: z
      .array(z.string().trim().toLowerCase().min(1))
      // order on the page is not meaningful; sort so it doesn't cause false "changes"
      .transform((tags) => [...new Set(tags)].sort()),
  })
  .strict();

export type BookRecord = z.output<typeof Book>;
export type QuoteRecord = z.output<typeof Quote>;
