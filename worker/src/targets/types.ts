import type { z } from "zod";

export type RawRecord = Record<string, unknown>;
export type CleanRecord = Record<string, unknown>;

/** One module per target: url(s), extractor, schema (plan §2 layout). */
export interface Target {
  id: string;
  name: string;
  baseUrl: string;
  /** Pages to fetch each run, in order. */
  pages: string[];
  /** Parse one page into raw (all-string) records. */
  extract(html: string, pageUrl: string): Promise<RawRecord[]>;
  /** Zod schema that normalizes + validates one raw record. */
  schema: z.ZodType<CleanRecord>;
  /** Stable natural key for a validated record (e.g. product URL). */
  keyOf(record: CleanRecord): string;
}
