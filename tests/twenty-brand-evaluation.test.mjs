import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("twenty-brand production matrix is bounded and preserves the required cohort", async () => {
  const source = await readFile(new URL("../scripts/run-twenty-brand-evaluation.mjs", import.meta.url), "utf8");
  const domainBlock = source.match(/const domains = \[([\s\S]*?)\];/);
  assert.ok(domainBlock);
  const cohort = [...domainBlock[1].matchAll(/"([a-z0-9.-]+\.(?:com|co\.uk))"/g)].map((match) => match[1]);
  assert.equal(cohort.length, 20);
  assert.equal(new Set(cohort).size, 20);
  assert.ok(cohort.includes("wearform.com"));
  assert.ok(cohort.includes("myjam.co.uk"));
  assert.match(source, /Math\.min\(3,/);
  assert.match(source, /20 \* 60_000/);
  assert.match(source, /missingRivalPriceViolations/);
  assert.match(source, /sourceViolations/);
  assert.match(source, /await persist\(artifact\)/);
  assert.match(source, /persistQueue = persistQueue\.then/);
});
