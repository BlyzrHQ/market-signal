import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("landing proves the product and moves supporting pages to dedicated routes", async () => {
  const [home, pricing, method, footer, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/pricing/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/how-it-works/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/site-footer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(home, /Proof, not promises/);
  assert.match(home, /Real output from the public MyJam report/);
  assert.match(home, /7fb305987e9a439abcbb352ee7302b26/);
  assert.match(home, /1,001 products found/);
  assert.match(home, /282 verified pairs/);
  assert.match(home, /24shopping\.shop/);
  assert.match(home, /bakkali\.app/);
  assert.match(home, /Only comparisons with a public rival price/);
  assert.match(home, /role="tablist"/);
  assert.match(home, /window\.setInterval/);
  assert.match(home, /prefers-reduced-motion: reduce/);
  assert.match(home, /href="\/pricing"/);
  assert.match(home, /href="\/how-it-works"/);
  assert.doesNotMatch(home, /standalone-pricing|Launch pricing targets/);

  assert.match(pricing, /price: "\$8"/);
  assert.match(pricing, /5 reports \/ month/);
  assert.match(pricing, /20 products \/ report/);
  assert.match(pricing, /50 products \/ report/);
  assert.match(pricing, /500 products \/ report/);
  assert.match(pricing, /1,000 products \/ report/);
  assert.equal((pricing.match(/Coming soon/g) || []).length, 2);
  assert.match(pricing, /billing is not active yet/i);
  assert.doesNotMatch(pricing, /products matched \/ report|Buy now|Checkout/);

  assert.match(method, /Products lead the search/);
  assert.match(method, /finite positive public price/);
  assert.match(footer, /Turn public market signals into clearer product decisions/);
  assert.match(footer, /github\.com\/BlyzrHQ\/market-signal/);
  assert.match(styles, /\.proof-browser/);
  assert.match(styles, /@keyframes systemFloat/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
});
