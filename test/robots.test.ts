import { describe, expect, it } from "vitest";
import { isAllowed, productToken } from "../worker/src/robots";

const ROBOTS = `
# example
User-agent: *
Disallow: /private/
Allow: /private/public-page.html
Disallow: /*.pdf$

User-agent: cf-scrape-monitor
User-agent: other-bot
Disallow: /catalogue/page-3.html

Sitemap: https://example.com/sitemap.xml
`;

describe("robots.txt", () => {
  it("allows everything when robots.txt is empty or missing", () => {
    expect(isAllowed("", "cf-scrape-monitor", "/anything")).toBe(true);
  });

  it("uses the group naming our token instead of '*'", () => {
    expect(isAllowed(ROBOTS, "cf-scrape-monitor", "/catalogue/page-3.html")).toBe(false);
    expect(isAllowed(ROBOTS, "cf-scrape-monitor", "/private/x")).toBe(true); // '*' group doesn't apply to us
  });

  it("falls back to '*' for other agents; longest match wins; supports * and $", () => {
    expect(isAllowed(ROBOTS, "somebot", "/private/x")).toBe(false);
    expect(isAllowed(ROBOTS, "somebot", "/private/public-page.html")).toBe(true);
    expect(isAllowed(ROBOTS, "somebot", "/files/report.pdf")).toBe(false);
    expect(isAllowed(ROBOTS, "somebot", "/files/report.pdf?x=1")).toBe(true);
  });

  it("treats an empty Disallow as allow-all", () => {
    expect(isAllowed("User-agent: *\nDisallow:\n", "x", "/a")).toBe(true);
  });

  it("extracts the product token from the User-Agent", () => {
    expect(productToken("cf-scrape-monitor/0.1 (+https://x/about)")).toBe("cf-scrape-monitor");
  });
});
