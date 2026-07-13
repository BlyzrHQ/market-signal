import assert from "node:assert/strict";
import test from "node:test";

import { postJson, readJsonResponse } from "../app/lib/json-response.ts";

test("reads a valid JSON API response", async () => {
  const payload = await readJsonResponse(new Response(JSON.stringify({ ok: true, rivals: 2 }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  }), "The competitor scan");

  assert.deepEqual(payload, { ok: true, rivals: 2 });
});

test("turns an HTML service error into a useful recovery message", async () => {
  await assert.rejects(
    readJsonResponse(new Response("<!DOCTYPE html><title>Gateway timeout</title>", {
      status: 504,
      headers: { "content-type": "text/html" },
    }), "The competitor scan"),
    /temporarily interrupted.*Run the scan again/i,
  );
});

test("turns an HTML authentication response into session guidance", async () => {
  await assert.rejects(
    readJsonResponse(new Response("<!DOCTYPE html><title>Sign in</title>", {
      status: 401,
      headers: { "content-type": "text/html" },
    }), "The competitor scan"),
    /session expired.*Refresh this page/i,
  );
});

test("turns a non-JSON service response into useful recovery guidance", async () => {
  await assert.rejects(
    readJsonResponse(new Response("Service warming up", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }), "The competitor scan"),
    /unexpected service page.*Refresh this page/i,
  );
});

test("does not expose the native JSON parser error for malformed data", async () => {
  await assert.rejects(
    readJsonResponse(new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    }), "The competitor scan"),
    (error) => {
      assert.match(error.message, /incomplete report data/i);
      assert.doesNotMatch(error.message, /Unexpected token|JSON/i);
      return true;
    },
  );
});

test("posts with explicit JSON and same-origin session headers", async () => {
  let observed;
  const payload = await postJson("/api/crawl", { primary: "https://myjam.co.uk/", domains: ["https://myjam.co.uk/"] }, "The competitor scan", async (url, init) => {
    observed = { url, init };
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  });

  assert.deepEqual(payload, { ok: true });
  assert.equal(observed.url, "/api/crawl");
  assert.equal(observed.init.credentials, "same-origin");
  assert.equal(observed.init.cache, "no-store");
  assert.equal(observed.init.headers.Accept, "application/json");
  assert.equal(JSON.parse(observed.init.body).primary, "https://myjam.co.uk/");
});
