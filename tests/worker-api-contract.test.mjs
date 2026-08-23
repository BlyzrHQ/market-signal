import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerCapabilitiesHandler } from "../app/api/internal/capabilities/route.ts";
import {
  ADVERTISED_WORKER_API_CAPABILITIES,
  LEGACY_AD_EXECUTION_CAPABILITY,
  REQUIRED_WORKER_API_CAPABILITIES,
  WORKER_API_PROTOCOL_VERSION,
  WORKER_API_SERVICE,
  WorkerApiContractError,
  createWorkerApiManifest,
  parseWorkerApiManifest,
} from "../src/shared/worker-api-contract.ts";

const TOKEN = "callback_secret_with_enough_entropy_123456";
const NOW = "2026-07-26T12:00:00.000Z";

test("worker API manifest is versioned, additive, and requires every core capability", () => {
  const manifest = createWorkerApiManifest(() => new Date(NOW));
  assert.deepEqual(parseWorkerApiManifest(manifest), manifest);
  assert.deepEqual(parseWorkerApiManifest({ ...manifest, capabilities: [...manifest.capabilities, "reports.export"] }).capabilities.at(-1), "reports.export");

  for (const invalid of [
    { ...manifest, service: "other-service" },
    { ...manifest, protocolVersion: "2" },
    { ...manifest, observedAt: "not-a-date" },
    { ...manifest, observedAt: "Jan 1 2020" },
    { ...manifest, capabilities: manifest.capabilities.slice(1) },
    { ...manifest, capabilities: [...manifest.capabilities, manifest.capabilities[0]] },
    { ...manifest, capabilities: [...manifest.capabilities, "bad capability"] },
  ]) assert.throws(() => parseWorkerApiManifest(invalid), WorkerApiContractError);

  assert.equal(manifest.service, WORKER_API_SERVICE);
  assert.equal(manifest.protocolVersion, WORKER_API_PROTOCOL_VERSION);
  assert.deepEqual(manifest.capabilities, [...ADVERTISED_WORKER_API_CAPABILITIES]);
  assert.deepEqual(REQUIRED_WORKER_API_CAPABILITIES, [
    "report.read", "report.event.append", "report.document.save", "crawl.execute",
    "products.match", "products.enrich", "products.actions",
  ]);
  assert.ok(manifest.capabilities.includes(LEGACY_AD_EXECUTION_CAPABILITY), "the compatibility manifest remains additive for one rollout");
});

test("worker API capability route is private and returns a no-store manifest", async () => {
  const handler = createWorkerCapabilitiesHandler(TOKEN, () => new Date(NOW));
  const unauthorized = await handler(new Request("https://market.example/api/internal/capabilities"));
  assert.equal(unauthorized.status, 401);

  const response = await handler(new Request("https://market.example/api/internal/capabilities", {
    headers: { authorization: `Bearer ${TOKEN}` },
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.observedAt, NOW);
  assert.deepEqual(parseWorkerApiManifest(body), body);
});
