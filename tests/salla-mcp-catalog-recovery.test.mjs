import assert from "node:assert/strict";
import test from "node:test";
import { recoverSallaStorefrontCatalog } from "../app/lib/salla-mcp-catalog-recovery.ts";

function result(text, overrides = {}) {
  return { ok: true, status: 200, contentType: "application/json", url: "https://shop.example/", text: JSON.stringify(text), truncated: false, responseTimeMs: 1, responseBytes: 10, redirectCount: 0, failureKind: "", ...overrides };
}

function rpcText(value) {
  return { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify(value) }] } };
}

function product(id, overrides = {}) {
  return {
    id,
    name: `Arabic honey ${id}`,
    description: "Observed catalog description",
    url: `https://shop.example/ar/honey/p${id}`,
    image: { url: `https://cdn.salla.sa/products/${id}.webp` },
    category: { name: "Honey" },
    price: 25 + Number(id),
    currency: "SAR",
    sku: `SKU-${id}`,
    ...overrides,
  };
}

test("official Salla MCP recovery returns bounded, priced storefront products across cursor pages", async () => {
  const requests = [];
  const fetchText = async (url, _accept, options) => {
    requests.push({ url, options });
    if (url.endsWith("server-card.json")) return result({ serverInfo: { name: "store", title: "Salla Store MCP Server" }, description: "Salla storefront", transport: { type: "streamable-http", endpoint: "/mcp" } });
    const body = JSON.parse(options.jsonRpcBody);
    if (body.method === "resources/read") return result({ jsonrpc: "2.0", result: { contents: [{ uri: "store://info", mimeType: "application/json", text: JSON.stringify({ store: { name: "Observed Store", url: "https://shop.example/ar/", country: "SA", store_country: "SA", scope: { countries: ["SA"], languages: ["ar", "en"] }, meta: { title: "Observed honey store", description: "Public store description" }, social: { instagram: "https://instagram.com/observed" } } }) }] } });
    if (!body.params.arguments.cursor) return result(rpcText({ items: [product("1"), product("2")], next_cursor: "https://api.salla.dev/store/v1/products?source=latest&cursor=safe-next" }));
    return result(rpcText({ items: [product("3"), product("4")], next_cursor: null }));
  };

  const recovered = await recoverSallaStorefrontCatalog("shop.example", { maxProducts: 3, fetchText, now: () => new Date("2026-08-16T00:00:00.000Z") });
  assert.equal(recovered?.products.length, 3);
  assert.equal(recovered?.products[0].priceSignals[0].currency, "SAR");
  assert.equal(recovered?.products[0].priceSignals[0].amount, 26);
  assert.equal(recovered?.products[0].extraction, "storefront-api");
  assert.equal(recovered?.products[0].imageUrl, "https://cdn.salla.sa/products/1.webp");
  assert.equal(recovered?.countryCode, "SA");
  assert.equal(recovered?.requests, 4);
  assert.equal(requests.length, 4);
  assert.equal(JSON.parse(requests.at(-1).options.jsonRpcBody).params.arguments.cursor, "safe-next");
  assert.equal(requests.at(-1).options.protocolVersion, "2025-06-18");
});

test("Salla recovery fails closed for an unverified server card", async () => {
  let calls = 0;
  const recovered = await recoverSallaStorefrontCatalog("shop.example", {
    maxProducts: 20,
    fetchText: async () => { calls += 1; return result({ serverInfo: { name: "unknown" }, transport: { type: "streamable-http", endpoint: "/mcp" } }); },
  });
  assert.equal(recovered, null);
  assert.equal(calls, 1);
});

test("Salla recovery rejects cross-domain store identity", async () => {
  const fetchText = async (url, _accept, options) => {
    if (url.endsWith("server-card.json")) return result({ serverInfo: { name: "Salla" }, description: "Salla", transport: { type: "streamable-http", endpoint: "/mcp" } });
    const body = JSON.parse(options.jsonRpcBody);
    if (body.method === "resources/read") return result({ jsonrpc: "2.0", result: { contents: [{ uri: "store://info", mimeType: "application/json", text: JSON.stringify({ store: { name: "Wrong store", url: "https://attacker.example/", country: "SA", scope: { countries: ["SA"] } } }) }] } });
    return result(rpcText({ items: [product("1", { url: "https://attacker.example/product" })], next_cursor: null }));
  };
  assert.equal(await recoverSallaStorefrontCatalog("shop.example", { maxProducts: 20, fetchText }), null);
});

test("Salla recovery does not follow an untrusted pagination cursor", async () => {
  let productCalls = 0;
  const fetchText = async (url, _accept, options) => {
    if (url.endsWith("server-card.json")) return result({ serverInfo: { name: "Salla" }, description: "Salla", transport: { type: "streamable-http", endpoint: "/mcp" } });
    const body = JSON.parse(options.jsonRpcBody);
    if (body.method === "resources/read") return result({ jsonrpc: "2.0", result: { contents: [{ uri: "store://info", mimeType: "application/json", text: JSON.stringify({ store: { name: "Store", url: "https://shop.example/", country: "SA", scope: { countries: ["SA"] } } }) }] } });
    productCalls += 1;
    return result(rpcText({ items: [product("1")], next_cursor: "https://attacker.example/steal?cursor=secret" }));
  };
  const recovered = await recoverSallaStorefrontCatalog("shop.example", { maxProducts: 20, fetchText });
  assert.equal(recovered?.products.length, 1);
  assert.equal(productCalls, 1);
});
