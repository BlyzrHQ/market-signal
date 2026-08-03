#!/usr/bin/env node

const origin = process.env.MARKET_SIGNAL_VERIFY_ORIGIN || "https://market-signal.abdulla617931.chatgpt.site";
const body = JSON.stringify({ primary: "babanuj.com", domains: ["babanuj.com"] });
const startedAt = Date.now();
const response = origin === "local-module"
  ? await (await import("../app/api/crawl/route.ts")).POST(new Request("https://local.test/api/crawl", { method: "POST", headers: { "content-type": "application/json" }, body }))
  : await fetch(`${origin.replace(/\/$/, "")}/api/crawl`, { method: "POST", headers: { "content-type": "application/json" }, body });
const payload = await response.json();
const primary = Array.isArray(payload.results) ? payload.results.find((entry) => entry?.domain === "babanuj.com") : null;
const expectedCurrentNames = [
  "Zaitoune Baklava with Honey Special Edition (Kol Shkor) 500g",
  "Zaitoune Sesame Cookies (Barazek)",
  "Zaitoune Mamoul With Walnut 600g",
  "Zaitoune Baklava Rolls (Mabrouma) 500g",
];
const staleNames = [
  "zaitoune sweets kol and shkor with honey 500g",
  "zaitoune sweets mixed nawashif 500g",
  "zaitoune sweets maamoul with walnut 500g",
  "zaitoune sweets mabrouma 400g",
];
const products = Array.isArray(primary?.products) ? primary.products : [];
const recovered = products.filter((product) => expectedCurrentNames.includes(product.name)).map((product) => ({
  id: product.id,
  name: product.name,
  imageUrl: product.imageUrl || null,
  prices: product.priceSignals || [],
  previousIdentity: product.attributes?.find((attribute) => attribute.startsWith("Previous sitemap identity:")) || null,
  sourceUrl: product.sourceUrl,
}));
const output = {
  observedAt: new Date().toISOString(),
  origin,
  status: response.status,
  ok: payload.ok === true,
  error: payload.error || null,
  elapsedMs: Date.now() - startedAt,
  primaryProductCount: products.length,
  reconciliationCoverage: primary?.catalogReconciliation || null,
  recoveredCount: recovered.length,
  recovered,
  staleRemaining: products.filter((product) => staleNames.includes(product.name)).map((product) => ({ id: product.id, name: product.name, sourceUrl: product.sourceUrl })),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (!output.ok || output.recoveredCount !== expectedCurrentNames.length || output.staleRemaining.length) process.exitCode = 1;
