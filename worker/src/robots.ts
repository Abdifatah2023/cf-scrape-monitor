// Minimal robots.txt evaluation (RFC 9309): pick the most specific matching
// user-agent group, then the longest matching Allow/Disallow rule wins
// (Allow wins a tie). Supports `*` wildcards and the `$` end anchor.

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

function parse(body: string): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (!cur) continue;
      // an empty Disallow means "allow everything"; it adds no rule
      if (value === "") continue;
      cur.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false; // sitemap, crawl-delay, ... end the agent list
    }
  }
  return groups;
}

function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

/** Is `pathAndQuery` allowed for the crawler whose product token is `agentToken`? */
export function isAllowed(robotsTxt: string, agentToken: string, pathAndQuery: string): boolean {
  const groups = parse(robotsTxt);
  const token = agentToken.toLowerCase();

  // most specific group: one naming our token; otherwise the '*' group(s)
  let chosen = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  if (chosen.length === 0) chosen = groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);

  let best: Rule | null = null;
  for (const rule of rules) {
    if (!toRegExp(rule.pattern).test(pathAndQuery)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/** "cf-scrape-monitor/0.1 (+https://...)" → "cf-scrape-monitor" */
export function productToken(userAgent: string): string {
  return userAgent.split(/[/\s]/)[0] || userAgent;
}
