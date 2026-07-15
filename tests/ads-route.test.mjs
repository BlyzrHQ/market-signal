import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "../app/api/ads/route.ts";

test("rejects an ad scan without verified company inputs", async () => {
  const response = await POST(new Request("http://localhost/api/ads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ region: "United Kingdom", companies: [{ domain: "localhost", brand: "Local" }] }),
  }));
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Verified companies are required/i);
});
