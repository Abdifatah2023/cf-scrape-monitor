// Small helpers shared by the HTMLRewriter-based extractors.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * HTMLRewriter hands us text and attribute values as they appear in the source,
 * so entities like `&amp;` or `&#39;` are still encoded. Decode the common ones.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

/** Collapse runs of whitespace (newlines, indentation) into single spaces and trim. */
export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Run an HTMLRewriter over an HTML string; resolves when the whole document is consumed. */
export async function rewrite(html: string, rewriter: HTMLRewriter): Promise<void> {
  const res = rewriter.transform(
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  await res.arrayBuffer();
}
