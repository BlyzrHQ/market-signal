export type RobotsPolicy = {
  sitemaps: string[];
  hasRules: boolean;
  allows: (path: string) => boolean;
};

export type RobotsAvailability = "available" | "missing" | "unreachable";

export function robotsAvailability(result: { ok: boolean; status: number } | null | undefined): RobotsAvailability {
  if (result?.ok) return "available";
  if (result && (result.status === 404 || result.status === 410)) return "missing";
  return "unreachable";
}

type Rule = { directive: "allow" | "disallow"; pattern: string };
type Group = { agents: string[]; rules: Rule[] };

function patternExpression(pattern: string) {
  const anchored = pattern.endsWith("$");
  const source = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

function specificity(pattern: string) {
  return pattern.replace(/\*|\$$/g, "").length;
}

export function parseRobots(text: string, userAgent = "MarketSignalPublicScanner/0.1"): RobotsPolicy {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let rulesStarted = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "sitemap" && /^https?:\/\//i.test(value)) {
      sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || rulesStarted) {
        current = { agents: [], rules: [] };
        groups.push(current);
        rulesStarted = false;
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }
    if ((key === "allow" || key === "disallow") && current) {
      rulesStarted = true;
      if (value) current.rules.push({ directive: key, pattern: value });
    }
  }

  const normalizedAgent = userAgent.toLowerCase();
  const candidates = groups.flatMap((group) => group.agents.flatMap((agent) => {
    const matches = agent === "*" || normalizedAgent.includes(agent);
    return matches ? [{ group, agent, score: agent === "*" ? 0 : agent.length }] : [];
  }));
  const bestAgentScore = Math.max(-1, ...candidates.map((candidate) => candidate.score));
  const rules = candidates
    .filter((candidate) => candidate.score === bestAgentScore)
    .flatMap((candidate) => candidate.group.rules);

  return {
    sitemaps: [...new Set(sitemaps)],
    hasRules: rules.length > 0,
    allows: (path: string) => {
      const matches = rules.flatMap((rule) => patternExpression(rule.pattern).test(path)
        ? [{ ...rule, score: specificity(rule.pattern) }]
        : []);
      if (!matches.length) return true;
      matches.sort((left, right) => right.score - left.score || Number(right.directive === "allow") - Number(left.directive === "allow"));
      return matches[0].directive === "allow";
    },
  };
}
