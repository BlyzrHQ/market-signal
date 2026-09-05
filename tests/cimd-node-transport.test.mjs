import assert from "node:assert/strict";
import test from "node:test";

import {
  createPinnedLookup,
  fetchPinnedClientMetadataResource,
} from "../app/lib/cimd-node-transport.ts";

test("pinned CIMD lookup supports Node's all-address callback shape", async () => {
  const lookup = createPinnedLookup({ address: "198.51.100.20", family: 4 });
  const addresses = await new Promise((resolve, reject) => {
    lookup("metadata.example", { all: true }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  assert.deepEqual(addresses, [{ address: "198.51.100.20", family: 4 }]);
});

test("pinned CIMD lookup supports Node's single-address callback shape", async () => {
  const lookup = createPinnedLookup({ address: "2001:db8::20", family: 6 });
  const result = await new Promise((resolve, reject) => {
    lookup("metadata.example", { all: false }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(result, { address: "2001:db8::20", family: 6 });
});

test("pinned CIMD transport rejects non-HTTPS and private destinations", async () => {
  await assert.rejects(
    () => fetchPinnedClientMetadataResource("http://metadata.example/client.json"),
    /requires an HTTPS URL/i,
  );
  await assert.rejects(
    () => fetchPinnedClientMetadataResource("https://127.0.0.1/client.json"),
    /must resolve only to public-routable addresses/i,
  );
});

test("pinned CIMD transport reads Codex's official metadata document", {
  skip: process.env.MARKET_SIGNAL_TEST_CIMD_NETWORK !== "1",
}, async () => {
  const response = await fetchPinnedClientMetadataResource(
    "https://chatgpt.com/oauth/codex/client.json",
    { headers: new Headers({ accept: "application/json" }), redirect: "error" },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/json\b/i);
  const metadata = await response.json();
  assert.equal(metadata.client_id, "https://chatgpt.com/oauth/codex/client.json");
  assert.ok(metadata.redirect_uris.includes("http://127.0.0.1/callback"));
  assert.equal(metadata.token_endpoint_auth_method, "none");
});
