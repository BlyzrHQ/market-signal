import assert from "node:assert/strict";
import test from "node:test";

import {
  forgetRememberedCompetitors,
  loadRememberedCompetitors,
  mergeRememberedCandidateCoverage,
  mergeRememberedCandidates,
  rememberVerifiedCompetitors,
} from "../app/lib/competitor-memory.ts";

function candidate(domain, provenance = "discovered-this-run") {
  return {
    domain,
    companyName: domain,
    reason: "Same live market category",
    searchQuery: "category competitors UK",
    sourceUrl: `https://${domain}/evidence`,
    websiteUrl: `https://${domain}/`,
    marketCategory: "grocery",
    relationship: "direct",
    sharedOfferings: ["grocery"],
    evidence: [{ url: `https://${domain}/evidence`, title: domain, method: "category-search" }],
    mentionCount: 1,
    provenance,
  };
}

function record(primaryDomain, competitorDomain, lastVerifiedAt, candidateJson = JSON.stringify(candidate(competitorDomain))) {
  return { primaryDomain, competitorDomain, candidateJson, firstVerifiedAt: lastVerifiedAt, lastVerifiedAt, lastVerificationScore: 82, category: "grocery", evidenceUrl: `https://${competitorDomain}/evidence` };
}

class FakeStatement {
  constructor(database, query) { this.database = database; this.query = query; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async all() {
    this.database.reads.push(this);
    const [primary, cutoff] = this.values;
    return { results: this.database.rows.filter((item) => item.primaryDomain === primary && item.lastVerifiedAt >= cutoff) };
  }
  async run() { return {}; }
}

class FakeDatabase {
  constructor(rows = []) { this.rows = rows; this.reads = []; this.batches = []; }
  prepare(query) { return new FakeStatement(this, query); }
  async batch(statements) { this.batches.push(statements); return statements.map(() => ({})); }
}

test("remembered leads preserve the full bounded fresh and remembered investigation set", () => {
  const fresh = Array.from({ length: 5 }, (_, index) => candidate(`fresh-${index}.test`));
  const remembered = Array.from({ length: 5 }, (_, index) => ({ ...candidate(`old-${index}.test`, "remembered-reverified"), rememberedVerifiedAt: "2026-07-14T00:00:00.000Z" }));
  const merged = mergeRememberedCandidates(fresh, remembered);
  assert.equal(merged.length, 10);
  assert.equal(merged.filter((item) => item.provenance === "remembered-reverified").length, 5);
  assert.equal(merged.filter((item) => item.provenance === "discovered-this-run").length, 5);
});

test("remembered continuity retains more than the former twenty-domain cutoff", () => {
  const remembered = Array.from({ length: 100 }, (_, index) => ({ ...candidate(`old-${index}.test`, "remembered-reverified"), rememberedVerifiedAt: "2026-07-14T00:00:00.000Z" }));
  assert.equal(mergeRememberedCandidates([], remembered).length, 100);
});

test("remembered persistence exposes overflow instead of claiming complete carry-forward", async () => {
  const observedAt = "2026-07-14T00:00:00.000Z";
  const database = new FakeDatabase(Array.from({ length: 501 }, (_, index) => record("myjam.co.uk", `remembered-${index}.test`, observedAt)));
  const loaded = await loadRememberedCompetitors("myjam.co.uk", new Date("2026-07-15T00:00:00.000Z"), database);
  assert.equal(loaded.candidates.length, 500);
  assert.equal(loaded.truncated, true);
  assert.match(loaded.gap, /cannot claim full market exhaustion/i);
});

test("remembered leads remain available when fresh discovery is sparse", () => {
  const remembered = Array.from({ length: 5 }, (_, index) => ({ ...candidate(`old-${index}.test`, "remembered-reverified"), rememberedVerifiedAt: "2026-07-14T00:00:00.000Z" }));
  const merged = mergeRememberedCandidates([candidate("fresh.test")], remembered);
  assert.equal(merged.length, 6);
  assert.equal(merged.filter((item) => item.provenance === "remembered-reverified").length, 5);
});

test("fresh same-domain product evidence is merged into remembered continuity", () => {
  const domain = "same-rival.test";
  const remembered = [{
    ...candidate(domain, "remembered-reverified"),
    matchedPrimaryProductName: "Old product",
    matchedProductUrl: `https://${domain}/products/old`,
    matchedPrimaryProductNames: ["Old product"],
    matchedProductUrls: [`https://${domain}/products/old`],
    rememberedVerifiedAt: "2026-07-14T00:00:00.000Z",
  }];
  const fresh = [{
    ...candidate(domain),
    matchedPrimaryProductName: "Fresh product",
    matchedProductUrl: `https://${domain}/products/fresh`,
    matchedPrimaryProductNames: ["Fresh product"],
    matchedProductUrls: [`https://${domain}/products/fresh`],
    evidence: [{ url: `https://${domain}/products/fresh`, title: "Fresh product", method: "product-search" }],
  }];

  const [merged] = mergeRememberedCandidates(fresh, remembered);
  assert.equal(merged.provenance, "discovered-this-run");
  assert.deepEqual(merged.matchedPrimaryProductNames, ["Fresh product", "Old product"]);
  assert.deepEqual(merged.matchedProductUrls, [`https://${domain}/products/fresh`, `https://${domain}/products/old`]);
  assert.equal(merged.evidence.length, 2);
});

test("same-seller evidence crosses the former 200-product boundary without silent loss", () => {
  const domain = "large-rival.test";
  const remembered = [{
    ...candidate(domain, "remembered-reverified"),
    matchedProductUrls: Array.from({ length: 200 }, (_, index) => `https://${domain}/products/old-${index}`),
  }];
  const freshUrl = `https://${domain}/products/fresh-200`;
  const fresh = [{ ...candidate(domain), matchedProductUrl: freshUrl, matchedProductUrls: [freshUrl] }];
  const [merged] = mergeRememberedCandidates(fresh, remembered);
  assert.equal(merged.matchedProductUrls.length, 201);
  assert.ok(merged.matchedProductUrls.includes(freshUrl));
});

test("aggregate remembered product evidence exposes overflow beyond the declared search universe", () => {
  const remembered = Array.from({ length: 2 }, (_, seller) => ({
    ...candidate(`large-${seller}.test`, "remembered-reverified"),
    matchedProductUrls: Array.from({ length: 3_001 }, (_, index) => `https://large-${seller}.test/products/${index}`),
  }));
  const merged = mergeRememberedCandidateCoverage([], remembered);
  assert.equal(merged.candidates.reduce((total, item) => total + item.matchedProductUrls.length, 0), 6_000);
  assert.equal(merged.truncated, true);
});

test("fresh-wave seller evidence takes priority over a full historical evidence budget", () => {
  const remembered = [{
    ...candidate("historical.test", "remembered-reverified"),
    matchedProductUrls: Array.from({ length: 6_000 }, (_, index) => `https://historical.test/products/${index}`),
  }];
  const freshUrl = "https://fresh.test/products/new";
  const merged = mergeRememberedCandidateCoverage([{ ...candidate("fresh.test"), matchedProductUrls: [freshUrl] }], remembered);
  assert.equal(merged.candidates[0].domain, "fresh.test");
  assert.deepEqual(merged.candidates[0].matchedProductUrls, [freshUrl]);
  assert.equal(merged.freshTruncated, false);
  assert.equal(merged.rememberedTruncated, true);
});

test("memory is isolated, expires old rows, and ignores malformed records", async () => {
  const database = new FakeDatabase([
    record("myjam.co.uk", "current.test", "2026-07-14T00:00:00.000Z"),
    record("other.test", "isolated.test", "2026-07-14T00:00:00.000Z"),
    record("myjam.co.uk", "expired.test", "2026-05-01T00:00:00.000Z"),
    record("myjam.co.uk", "malformed.test", "2026-07-14T00:00:00.000Z", "{not-json"),
  ]);
  const result = await loadRememberedCompetitors("https://MYJAM.co.uk/", new Date("2026-07-15T00:00:00.000Z"), database);
  assert.equal(result.available, true);
  assert.deepEqual(result.candidates.map((item) => item.domain), ["current.test"]);
  assert.equal(result.candidates[0].provenance, "remembered-reverified");
  assert.equal(result.candidates[0].rememberedVerifiedAt, "2026-07-14T00:00:00.000Z");
  assert.deepEqual(database.reads[0].values, ["myjam.co.uk", "2026-06-15T00:00:00.000Z"]);
});

test("remembered competitors restore attributable primary-to-seller product bindings", async () => {
  const lead = {
    primaryProductId: "primary-13",
    primarySourceUrl: "https://myjam.co.uk/products/halal-product-13",
    laneQuery: "halal product 13 500g",
    candidateDomain: "rival.test",
    candidateSourceUrl: "https://rival.test/products/halal-product-13",
    admission: "inferred-cross-language",
  };
  const storedCandidate = { ...candidate("rival.test"), inferredProductLeads: [lead, { ...lead, candidateSourceUrl: "https://other.test/wrong" }] };
  const database = new FakeDatabase([record("myjam.co.uk", "rival.test", "2026-07-14T00:00:00.000Z", JSON.stringify(storedCandidate))]);
  const result = await loadRememberedCompetitors("myjam.co.uk", new Date("2026-07-15T00:00:00.000Z"), database);

  assert.deepEqual(result.candidates[0].inferredProductLeads, [lead]);
});

test("verified leads whitelist lead evidence, upsert, and delete by canonical domain", async () => {
  const database = new FakeDatabase();
  const verified = {
    ...candidate("Rival.TEST", "remembered-reverified"),
    rememberedVerifiedAt: "2026-07-01T00:00:00.000Z",
    accepted: true,
    verificationScore: 84,
    overlapTerms: ["grocery"],
    provenPrimaryProduct: { name: "Primary item", priceSignals: [{ raw: "GBP 9" }] },
    provenRivalProduct: { name: "Rival item", priceSignals: [{ raw: "GBP 8" }] },
    inferredProductLeads: [{ primaryProductId: "primary-13", primarySourceUrl: "https://myjam.co.uk/products/item", laneQuery: "primary item", candidateDomain: "rival.test", candidateSourceUrl: "https://rival.test/products/item", admission: "source-first-cross-language" }],
  };
  const stored = await rememberVerifiedCompetitors("https://MYJAM.co.uk/", [{ candidate: verified, verificationScore: 83.6 }], "2026-07-15T12:00:00.000Z", database);
  const removed = await forgetRememberedCompetitors("MYJAM.co.uk", ["https://RIVAL.test/shop"], database);
  assert.deepEqual(stored, { available: true, stored: 1 });
  assert.deepEqual(removed, { available: true, removed: 1 });
  const mutations = database.batches.filter((batch) => !batch[0]?.query.startsWith("CREATE TABLE"));
  assert.equal(mutations.length, 2);
  assert.match(mutations[0][0].query, /ON CONFLICT\(primary_domain, competitor_domain\) DO UPDATE/);
  assert.deepEqual(mutations[0][0].values.slice(0, 2), ["myjam.co.uk", "rival.test"]);
  assert.equal(mutations[0][0].values[5], 84);
  const storedJson = JSON.parse(mutations[0][0].values[2]);
  assert.equal("provenance" in storedJson, false);
  assert.equal("rememberedVerifiedAt" in storedJson, false);
  assert.equal("accepted" in storedJson, false);
  assert.equal("verificationScore" in storedJson, false);
  assert.equal("overlapTerms" in storedJson, false);
  assert.equal("provenPrimaryProduct" in storedJson, false);
  assert.equal("provenRivalProduct" in storedJson, false);
  assert.equal(storedJson.inferredProductLeads.length, 1);
  assert.doesNotMatch(mutations[0][0].values[2], /priceSignals|GBP 9|GBP 8/);
  assert.match(mutations[1][0].query, /^DELETE FROM verified_competitors/);
  assert.deepEqual(mutations[1][0].values, ["myjam.co.uk", "rival.test"]);
});

test("unavailable persistence is a visible non-fatal coverage gap", async () => {
  const loaded = await loadRememberedCompetitors("myjam.co.uk", new Date(), null);
  const stored = await rememberVerifiedCompetitors("myjam.co.uk", [{ candidate: candidate("rival.test"), verificationScore: 80 }], undefined, null);
  assert.equal(loaded.available, false);
  assert.equal(loaded.truncated, true);
  assert.match(loaded.gap, /not configured/);
  assert.deepEqual(stored, { available: false, stored: 0 });
});
