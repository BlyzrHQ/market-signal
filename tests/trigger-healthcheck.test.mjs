import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createHealthcheckOutput,
  HEALTHCHECK_CONTRACT_VERSION,
  TRIGGER_SDK_VERSION,
} from "../src/trigger/contracts/healthcheck.ts";

test("healthcheck contract echoes a live nonce with stable version metadata", () => {
  const output = createHealthcheckOutput(
    { nonce: "roundtrip_20260720" },
    () => new Date("2026-07-20T11:30:00.000Z"),
  );

  assert.deepEqual(output, {
    ok: true,
    contractVersion: HEALTHCHECK_CONTRACT_VERSION,
    nonce: "roundtrip_20260720",
    sdkVersion: TRIGGER_SDK_VERSION,
    observedAt: "2026-07-20T11:30:00.000Z",
  });
});

test("healthcheck contract rejects missing, unsafe, and oversized nonces", () => {
  for (const nonce of ["", "short", "contains space", "x".repeat(129)]) {
    assert.throws(
      () => createHealthcheckOutput({ nonce }),
      /nonce must be 8-128 URL-safe characters/i,
    );
  }
});

test("healthcheck contract has no network or Trigger environment dependency", () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be used");
  };
  try {
    const output = createHealthcheckOutput(
      { nonce: "offline_contract" },
      () => new Date("2026-07-20T11:31:00.000Z"),
    );
    assert.equal(output.ok, true);
    assert.equal(output.nonce, "offline_contract");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("reported Trigger SDK version is pinned to the installed dependency contract", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.dependencies["@trigger.dev/sdk"], TRIGGER_SDK_VERSION);
  assert.equal(packageJson.devDependencies["@trigger.dev/build"], TRIGGER_SDK_VERSION);
});
