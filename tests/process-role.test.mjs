import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { workerOnlyResponse } from "../app/lib/process-role.ts";

test("customer app rejects report-processing routes while worker and local tests allow them", async () => {
  const rejected = workerOnlyResponse("app");
  assert.equal(rejected?.status, 503);
  assert.equal(rejected?.headers.get("cache-control"), "no-store");
  assert.equal(workerOnlyResponse("worker"), null);
  assert.equal(workerOnlyResponse(""), null);

  for (const route of ["crawl", "report", "match", "enrich-products", "actions"]) {
    const source = fs.readFileSync(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /workerOnlyResponse\(\)/, `${route} must enforce the process role`);
  }
});
