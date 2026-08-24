import assert from "node:assert/strict";
import test from "node:test";

import {
  isShopifyUcpCatalogRecoveryEligible,
  recoverShopifyUcpCatalog,
  shopifyCheckoutHost,
} from "../app/lib/shopify-ucp-catalog-recovery.ts";
import { shopifyRecoveryDomainCrawl } from "../app/api/crawl/route.ts";

const endpoint = "https://checkout.shop.example/api/ucp/mcp";

function response(payload, overrides = {}) {
  return {
    ok: true,
    status: 200,
    contentType: "application/json",
    url: endpoint,
    text: JSON.stringify(payload),
    truncated: false,
    responseTimeMs: 1,
    responseBytes: 100,
    redirectCount: 0,
    failureKind: "",
    ...overrides,
  };
}

function tools(id = "shopify-tools") {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: [{
        name: "search_catalog",
        description: "Search for products from the online store, hosted on Shopify. Response conforms to the UCP catalog search capability.",
      }],
    },
  };
}

function product(id, overrides = {}) {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Observed product ${id}`,
    description: { html: `<p>Observed description ${id}</p>` },
    url: `https://checkout.shop.example/products/observed-${id}`,
    categories: [{ value: "Merchant category", taxonomy: "merchant" }],
    price_range: { min: { amount: 1299, currency: "USD" }, max: { amount: 1299, currency: "USD" } },
    media: [{ type: "image", url: `https://cdn.shopify.com/product-${id}.jpg` }],
    variants: [],
    ...overrides,
  };
}

function search(id, products, pagination = { has_next_page: false }, overrides = {}) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: {
        ucp: {
          version: "2026-04-08",
          status: "success",
          capabilities: {
            "dev.ucp.shopping.catalog.search": [{ version: "2026-04-08" }],
            "dev.shopify.catalog": [{ version: "2026-04-08" }],
          },
        },
        products,
        pagination,
        ...overrides,
      },
    },
  };
}

function successfulFetch(pages) {
  const requests = [];
  const fetchText = async (url, _accept, options) => {
    requests.push({ url, options });
    const body = JSON.parse(options.jsonRpcBody);
    if (body.method === "tools/list") return response(tools(body.id));
    return response(pages.shift()(body));
  };
  return { requests, fetchText };
}

test("derives the exact checkout host with public-suffix and private-suffix awareness", () => {
  assert.equal(shopifyCheckoutHost("https://www.shop.co.uk/path"), "checkout.shop.co.uk");
  assert.equal(shopifyCheckoutHost("tenant.github.io"), "checkout.tenant.github.io");
  assert.equal(shopifyCheckoutHost("babanuj.com"), "checkout.babanuj.com");
  assert.equal(shopifyCheckoutHost("localhost"), "");
});

test("Shopify recovery is eligible only after verified dual-host HTTP 403", () => {
  assert.equal(isShopifyUcpCatalogRecoveryEligible({ homepage: null }), false);
  assert.equal(isShopifyUcpCatalogRecoveryEligible({ homepage: null, homepageAccessDenied: { status: 429, hosts: ["shop.example", "www.shop.example"] } }), false);
  assert.equal(isShopifyUcpCatalogRecoveryEligible({ homepage: null, homepageAccessDenied: { status: 403, hosts: ["shop.example"] } }), false);
  assert.equal(isShopifyUcpCatalogRecoveryEligible({ homepage: null, homepageAccessDenied: { status: 403, hosts: ["shop.example", "www.shop.example"] } }), true);
  assert.equal(isShopifyUcpCatalogRecoveryEligible({ homepage: {}, homepageAccessDenied: { status: 403, hosts: ["shop.example", "www.shop.example"] } }), false);
});

test("recovers bounded, priced Shopify products across opaque cursor pages", async () => {
  const pages = [
    (body) => search(body.id, [
      product("1"),
      product("2", { price_range: { min: { amount: 1250, currency: "KWD" } } }),
    ], { has_next_page: true, cursor: "safe_cursor=" }),
    (body) => search(body.id, [
      product("3", { price_range: { min: { amount: 1250, currency: "JPY" } } }),
      product("4"),
    ]),
  ];
  const { requests, fetchText } = successfulFetch(pages);
  const recovered = await recoverShopifyUcpCatalog("shop.example", {
    maxProducts: 3,
    fetchText,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
  });

  assert.equal(recovered?.products.length, 3);
  assert.equal(recovered?.products[0].priceSignals[0].amount, 12.99);
  assert.equal(recovered?.products[1].priceSignals[0].amount, 1.25);
  assert.equal(recovered?.products[1].priceSignals[0].raw, "KWD 1.250");
  assert.equal(recovered?.products[2].priceSignals[0].amount, 1250);
  assert.equal(recovered?.products[2].priceSignals[0].raw, "JPY 1250");
  assert.equal(recovered?.products[0].extraction, "storefront-api");
  assert.equal(recovered?.products[0].sourceUrl, "https://checkout.shop.example/products/observed-1");
  assert.equal(recovered?.products[0].imageUrl, "https://cdn.shopify.com/product-1.jpg");
  assert.equal(recovered?.requests, 3);
  assert.equal(recovered?.truncated, true);
  assert.equal(requests.length, 3);
  assert.equal(requests.every((request) => request.url === endpoint), true);
  assert.equal(requests.every((request) => request.options.expectedDomain === "checkout.shop.example"), true);
  assert.equal(requests.every((request) => request.options.timeoutMs === 12_000), true);
  const secondSearch = JSON.parse(requests[2].options.jsonRpcBody);
  assert.equal(secondSearch.params.arguments.catalog.pagination.cursor, "safe_cursor=");
  assert.equal(secondSearch.params.arguments.meta["ucp-agent"].profile.startsWith("https://shopify.dev/"), true);
});

test("continues past products with missing or invalid prices and never publishes them", async () => {
  const pages = [
    (body) => search(body.id, [
      product("1", { price_range: {}, variants: [] }),
      product("2", { price_range: { min: { amount: 0, currency: "USD" } } }),
      product("3", { price_range: {}, variants: [{ availability: { available: true }, price: { amount: 725, currency: "USD" } }] }),
    ], { has_next_page: true, cursor: "next" }),
    (body) => search(body.id, [product("4")]),
  ];
  const { fetchText } = successfulFetch(pages);
  const recovered = await recoverShopifyUcpCatalog("shop.example", { maxProducts: 2, fetchText });
  assert.deepEqual(recovered?.products.map((item) => item.id), ["shop.example:shopify-ucp:3", "shop.example:shopify-ucp:4"]);
  assert.equal(recovered?.products.every((item) => item.priceSignals[0].amount > 0), true);
  assert.equal(recovered?.truncated, false);
});

test("prefers a positive available variant price over a range that may include unavailable variants", async () => {
  const { fetchText } = successfulFetch([(body) => search(body.id, [product("1", {
    price_range: { min: { amount: 499, currency: "USD" } },
    variants: [
      { availability: { available: false }, price: { amount: 499, currency: "USD" } },
      { availability: { available: true }, price: { amount: 899, currency: "USD" } },
    ],
  })])]);
  const recovered = await recoverShopifyUcpCatalog("shop.example", { maxProducts: 1, fetchText });
  assert.equal(recovered?.products[0].priceSignals[0].amount, 8.99);
  assert.equal(recovered?.products[0].priceSignals[0].raw, "USD 8.99");
});

test("fails closed when the endpoint redirects or its Shopify identity is not verified", async (t) => {
  await t.test("redirect", async () => {
    const recovered = await recoverShopifyUcpCatalog("shop.example", {
      maxProducts: 2,
      fetchText: async () => response(tools(), { redirectCount: 1, url: "https://www.checkout.shop.example/api/ucp/mcp" }),
    });
    assert.equal(recovered, null);
  });

  await t.test("unrelated server", async () => {
    const recovered = await recoverShopifyUcpCatalog("shop.example", {
      maxProducts: 2,
      fetchText: async () => response({ jsonrpc: "2.0", id: "shopify-tools", result: { tools: [{ name: "search_catalog", description: "Generic catalog" }] } }),
    });
    assert.equal(recovered, null);
  });
});

test("rejects cross-host products, malformed cursors, and mismatched JSON-RPC ids", async (t) => {
  await t.test("cross-host product", async () => {
    const { fetchText } = successfulFetch([(body) => search(body.id, [product("1", { url: "https://attacker.example/products/stolen" })])]);
    assert.equal(await recoverShopifyUcpCatalog("shop.example", { maxProducts: 2, fetchText }), null);
  });

  await t.test("malformed cursor", async () => {
    const { fetchText } = successfulFetch([(body) => search(body.id, [product("1")], { has_next_page: true, cursor: "https://attacker.example/next" })]);
    assert.equal(await recoverShopifyUcpCatalog("shop.example", { maxProducts: 2, fetchText }), null);
  });

  await t.test("mismatched id", async () => {
    const recovered = await recoverShopifyUcpCatalog("shop.example", {
      maxProducts: 2,
      fetchText: async () => response(tools("wrong-id")),
    });
    assert.equal(recovered, null);
  });
});

test("rejects malformed UCP metadata and bounds the requested product count", async (t) => {
  await t.test("wrong UCP version", async () => {
    const { fetchText } = successfulFetch([(body) => {
      const payload = search(body.id, [product("1")]);
      payload.result.structuredContent.ucp.version = "2026-01-23";
      return payload;
    }]);
    assert.equal(await recoverShopifyUcpCatalog("shop.example", { maxProducts: 2, fetchText }), null);
  });

  await t.test("maximum", async () => {
    const page = Array.from({ length: 101 }, (_, index) => product(String(index + 1)));
    const { fetchText } = successfulFetch([(body) => search(body.id, page)]);
    const recovered = await recoverShopifyUcpCatalog("shop.example", { maxProducts: 20, fetchText });
    assert.equal(recovered?.products.length, 20);
  });
});

test("the crawl route replaces a verified dual-host 403 with the priced public catalog", async () => {
  const previous = {
    domain: "shop.example",
    role: "primary",
    homepage: null,
    pages: [],
    products: [],
    candidates: [],
    gaps: [{
      url: "https://shop.example/",
      reason: "homepage returned HTTP 403.",
      observedAt: "2026-08-24T00:00:00.000Z",
    }],
    coverage: { pagesRequested: 4, pagesFetched: 0, maxPages: 5, robotsChecked: true, attempts: 2 },
    productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 },
    fetchedAt: "2026-08-24T00:00:00.000Z",
    homepageAccessDenied: { status: 403, hosts: ["shop.example", "www.shop.example"] },
  };
  assert.equal(isShopifyUcpCatalogRecoveryEligible(previous), true);

  const { fetchText } = successfulFetch([(body) => search(body.id, [product("1")])]);
  const catalog = await recoverShopifyUcpCatalog("shop.example", {
    maxProducts: 20,
    fetchText,
    now: () => new Date("2026-08-24T00:05:00.000Z"),
  });
  assert.ok(catalog);

  const recovered = await shopifyRecoveryDomainCrawl(previous, 20, async () => catalog);
  assert.equal(recovered?.homepage?.live, true);
  assert.equal(recovered?.homepage?.sourceUrl, endpoint);
  assert.equal(recovered?.products.length, 1);
  assert.equal(recovered?.products[0].priceSignals[0].amount, 12.99);
  assert.equal(recovered?.products[0].sourceUrl, "https://checkout.shop.example/products/observed-1");
  assert.equal(recovered?.coverage.pagesRequested, 6);
  assert.equal(recovered?.coverage.attempts, 2);
  assert.equal(recovered?.productCoverage.catalogProductsDiscovered, 1);
  assert.equal(recovered?.benchmarkEligible, false);
  assert.match(recovered?.gaps.at(-1)?.reason || "", /recovered 1 positively priced product/i);
});
