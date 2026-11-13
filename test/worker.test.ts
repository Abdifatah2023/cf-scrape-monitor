import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Only the auth paths are tested here; a successful /run would hit the real network.
describe("POST /run", () => {
  it("rejects GET", async () => {
    const res = await SELF.fetch("https://w.example/run");
    expect(res.status).toBe(405);
  });

  it("rejects a missing or wrong token", async () => {
    expect((await SELF.fetch("https://w.example/run", { method: "POST" })).status).toBe(401);
    const wrong = await SELF.fetch("https://w.example/run", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });
});
