import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("landing pricing exposes honest hosted and self-hosted plan targets", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /href="#pricing"/);
  assert.match(page, /id="pricing"/);
  assert.match(page, /Self-host for free/);
  assert.match(page, /<strong>\$8<\/strong>/);
  assert.match(page, /<b>5<\/b>[\s\S]*completed reports \/ month/);
  assert.match(page, /<b>20<\/b>[\s\S]*products analyzed \/ report/);
  assert.match(page, /<h3>Solo<\/h3>[\s\S]*<b>50<\/b>/);
  assert.match(page, /<h3>Growth<\/h3>[\s\S]*<b>500<\/b>/);
  assert.match(page, /<h3>Agency<\/h3>[\s\S]*<b>1,000<\/b>/);
  assert.equal((page.match(/Coming soon/g) || []).length, 2);
  assert.match(page, /launch pricing targets, not active billing yet/i);
  assert.doesNotMatch(page, /products matched \/ report|Buy now|Checkout/);
  assert.match(styles, /\.pricing-grid \{[^}]*repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.pricing-card \{[^}]*min-width: 0/);
});
