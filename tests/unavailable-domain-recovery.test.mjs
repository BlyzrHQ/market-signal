import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the crawl API returns a typed unavailable-domain result before market discovery", async () => {
  const route = await readFile(new URL("../app/api/crawl/route.ts", import.meta.url), "utf8");
  assert.match(route, /primary\?\.siteState\?\.status === "unavailable"/);
  assert.match(route, /code: "unavailable-domain"/);
  assert.match(route, /attempts: primary\.coverage\.attempts \|\| 2/);
  assert.match(route, /status: 409/);
  assert.ok(route.indexOf('code: "unavailable-domain"') < route.indexOf("let discovery: DiscoveryResult"));
});

test("the saved unavailable report hides empty market tabs and explains skipped work", async () => {
  const report = await readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8");
  assert.match(report, /\["parked", "unavailable"\]/);
  assert.match(report, /No public website response was available for this domain/);
  assert.match(report, /This is not a zero-result report/);
  assert.match(report, /Competitors, products, and ads were not checked/);
  assert.match(report, /Open attempted address/);
});
