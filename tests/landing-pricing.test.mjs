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
  assert.match(home, /documented snapshot from a public MyJam run/i);
  assert.match(home, /limited coverage, observed 8 August 2026/i);
  assert.doesNotMatch(home, /7fb305987e9a439abcbb352ee7302b26/);
  assert.match(home, /1,001 products found/);
  assert.match(home, /282 priced, AI-assessed matches/);
  assert.match(home, /AI-assessed close substitute/);
  assert.match(home, /rivalSource: "https:\/\/bakkali\.app\/products\/castania-mixed-kernels-450g"/);
  assert.match(home, /arSignal: "المنافس أقل بـ 3\.25£"/);
  assert.match(home, /24shopping\.shop/);
  assert.match(home, /bakkali\.app/);
  assert.match(home, /Only comparisons with a public rival price/);
  assert.match(home, /role="tablist"/);
  assert.doesNotMatch(home, /window\.setInterval/);
  assert.match(home, /EXAMPLE WORKFLOW/);
  assert.match(home, /RECORDED MYJAM RUN/);
  assert.match(home, /tabIndex=\{view === item \? 0 : -1\}/);
  assert.match(home, /aria-controls=\{`proof-panel-/);
  assert.match(home, /ArrowLeft/);
  assert.match(home, /"\/pricing"/);
  assert.match(home, /"\/how-it-works"/);
  assert.doesNotMatch(home, /standalone-pricing|Launch pricing targets/);

  assert.match(pricing, /price: "\$8"/);
  assert.match(pricing, /reports: "5"/);
  assert.match(pricing, /products: "20"/);
  assert.match(pricing, /products: "50"/);
  assert.match(pricing, /products: "500"/);
  assert.match(pricing, /products: "1,000"/);
  assert.match(pricing, /price: "\$79"/);
  assert.match(pricing, /price: "\$199"/);
  assert.match(pricing, /Self-hosted edition/);
  assert.match(pricing, /billing is not active yet/i);
  assert.doesNotMatch(pricing, /products matched \/ report|Buy now|Checkout/);

  assert.match(method, /Products lead the search/);
  assert.match(method, /finite positive public price/);
  assert.match(footer, /Turn public market signals into clearer product decisions/);
  assert.match(footer, /github\.com\/BlyzrHQ\/market-signal/);
  assert.match(styles, /\.proof-browser/);
  assert.match(styles, /@keyframes systemFloat/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(styles, /var\(--font-geist-sans\)/);
});
