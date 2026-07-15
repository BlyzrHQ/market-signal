import assert from "node:assert/strict";
import test from "node:test";

import { seededCrawlPaths } from "../app/lib/crawl-planning.ts";

test("competitor crawl seeds never spend an expansion slot on the homepage", () => {
  assert.deepEqual(seededCrawlPaths([
    "https://rival.example/",
    "https://rival.example/products/sidr-honey",
    "https://other.example/products/not-this-site",
  ], "rival.example"), ["/products/sidr-honey"]);
});
