import { canonicalDomain } from "./domain.ts";

export function seededCrawlPaths(values: string[], domain: string) {
  return values.flatMap((value) => {
    try {
      const url = new URL(value);
      if (canonicalDomain(url.hostname) !== canonicalDomain(domain) || (url.pathname === "/" && !url.search)) return [];
      return [`${url.pathname}${url.search}`];
    } catch {
      return [];
    }
  });
}
