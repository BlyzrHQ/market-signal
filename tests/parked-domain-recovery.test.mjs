import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { discoverDomainAlternatives, extractStaticClientRedirect, parkingProvider } from "../app/lib/domain-recovery.ts";

test("stops a parked primary domain and returns bounded evidence-backed alternatives", async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/responses")) return Response.json({
      output: [{
        type: "web_search_call",
        action: {
          query: "noor organic official website",
          sources: [
            { title: "Noor Organic Food Kuwait", url: "https://noororganicfood.com/en?utm_source=search" },
            { title: "Noor Organic Honey India", url: "https://noororganichoney.com/" },
            { title: "Noor Organic on Instagram", url: "https://instagram.com/noororganic" },
            { title: "Unrelated Organic Shop", url: "https://unrelated.example/" },
          ],
        },
      }],
    });
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const shell = '<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>';
    assert.equal(extractStaticClientRedirect(shell, "https://noororganic.com/"), "https://noororganic.com/lander");
    assert.equal(parkingProvider("forsale.godaddy.com"), "GoDaddy/Afternic");
    const alternatives = await discoverDomainAlternatives("noororganic.com");
    assert.deepEqual(alternatives.map((item) => item.domain), ["noororganicfood.com", "noororganichoney.com"]);
    assert.equal(alternatives[0].sourceUrl, "https://noororganicfood.com/en");
    assert.equal(calls.filter((url) => url.endsWith("/responses")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});

test("does not classify an operational HTML storefront as parked", async () => {
  const operational = '<!doctype html><html><head><title>Active Shop</title></head><body><h1>Organic honey</h1><p>Our working storefront sells honey.</p></body></html>';
  assert.equal(extractStaticClientRedirect(operational, "https://active-shop.example/"), "");
  assert.equal(parkingProvider("checkout.active-shop.example"), "");
});

test("renders parked-domain alternatives as explicit user-selected reruns", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /type DomainAlternative/);
  assert.match(page, /domainAlternatives\.map/);
  assert.match(page, /analyze\(alternative\.domain\)/);
  assert.match(page, /sourceUrl/);
  assert.match(page, /const parked = "code" in payload && payload\.code === "parked-domain"/);
  assert.match(page, /if \(!parked && payload\.document\) setCrawlDocument/);
  assert.match(page, /if \(!parked\) window\.setTimeout/);
  assert.match(styles, /\.domain-alternatives/);
});

test("the crawl API returns a parked-domain conflict before competitor discovery", async () => {
  const route = await readFile(new URL("../app/api/crawl/route.ts", import.meta.url), "utf8");
  assert.match(route, /primary\?\.siteState\?\.status === "parked"/);
  assert.match(route, /code: "parked-domain"/);
  assert.match(route, /status: 409/);
  assert.ok(route.indexOf('code: "parked-domain"') < route.indexOf("let discovery: DiscoveryResult"));
});
