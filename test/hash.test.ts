import { describe, expect, it } from "vitest";
import { canonicalJson, diffFields, hashRecord } from "../worker/src/hash";

describe("canonical hashing", () => {
  it("is independent of key order (at every level)", async () => {
    const a = { title: "T", price: 1, meta: { x: 1, y: [1, 2] } };
    const b = { meta: { y: [1, 2], x: 1 }, price: 1, title: "T" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await hashRecord(a)).toBe(await hashRecord(b));
  });

  it("ignores provenance fields", async () => {
    const a = { title: "T", source_url: "https://x/page-1.html" };
    const b = { title: "T", source_url: "https://x/page-2.html" };
    expect(await hashRecord(a)).toBe(await hashRecord(b));
  });

  it("changes when content changes", async () => {
    expect(await hashRecord({ price: 1 })).not.toBe(await hashRecord({ price: 2 }));
  });

  it("produces a 64-char hex SHA-256", async () => {
    expect(await hashRecord({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("diffFields", () => {
  it("lists only changed content fields, as text", () => {
    const old = { title: "T", price: 51.77, in_stock: true, tags: ["a"], source_url: "p1" };
    const now = { title: "T", price: 45, in_stock: false, tags: ["a", "b"], source_url: "p2" };
    expect(diffFields(old, now)).toEqual([
      { field: "in_stock", old_value: "true", new_value: "false" },
      { field: "price", old_value: "51.77", new_value: "45" },
      { field: "tags", old_value: '["a"]', new_value: '["a","b"]' },
    ]);
  });

  it("reports added and dropped fields", () => {
    expect(diffFields({ a: 1 }, { b: 2 })).toEqual([
      { field: "a", old_value: "1", new_value: null },
      { field: "b", old_value: null, new_value: "2" },
    ]);
  });
});
