import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { enrichProductTargets } from "./storefront-product-enrichment.ts";
import { publicSourceMarketCountryCode, type ProductRecord } from "./product-intelligence.ts";
import type { CanonicalProductQuantity } from "./product-normalization.ts";
import {
  beginPriceWatchAttempt,
  claimDuePriceWatchers,
  completePriceWatchClaim,
  releasePriceWatchClaim,
  type PriceWatchClaim,
} from "./price-watch-store.ts";
import { canonicalPriceWatchUrl, currentPriceSnapshot, type PriceWatchPriceSnapshot } from "./price-watch-target.ts";

export type PriceWatchInspection = {
  ok: boolean;
  snapshot: PriceWatchPriceSnapshot | null;
  observedUrl: string;
  code: string;
  transient: boolean;
};

export type PriceWatchRunnerDependencies = {
  inspect?: (claim: PriceWatchClaim) => Promise<PriceWatchInspection>;
  now?: () => Date;
};

// Keep one scheduled HTTP invocation comfortably below Trigger's five-minute
// ceiling even when every target belongs to the same rival domain and requires
// a transient retry or change confirmation.
export const PRICE_WATCH_BATCH_LIMIT = 8;

function samePrice(left: PriceWatchPriceSnapshot | null, right: PriceWatchPriceSnapshot | null) {
  return Boolean(left && right
    && left.currency === right.currency
    && left.amountMicros === right.amountMicros
    && left.listAmountMicros === right.listAmountMicros);
}

function transientCoverageGap(gap: Record<string, unknown>) {
  const status = Number(gap.httpStatus);
  return gap.failureKind === "network" || status === 429 || status >= 500;
}

function claimExpectedQuantity(claim: PriceWatchClaim): CanonicalProductQuantity | undefined {
  try {
    const identity = JSON.parse(claim.variantJson) as { quantity?: Record<string, unknown> | null };
    const quantity = identity.quantity;
    const kind = String(quantity?.kind || "");
    const unit = String(quantity?.unit || "");
    const amount = Number(quantity?.amount);
    if (!["mass", "volume", "count"].includes(kind)
      || !["g", "ml", "pcs", "pack"].includes(unit)
      || !Number.isFinite(amount)
      || amount <= 0) return undefined;
    return { kind, unit, amount } as CanonicalProductQuantity;
  } catch {
    return undefined;
  }
}

type PriceWatchTargetInspectorDependencies = {
  enrich?: typeof enrichProductTargets;
};

export async function inspectExactPriceWatchTarget(
  claim: PriceWatchClaim,
  dependencies: PriceWatchTargetInspectorDependencies = {},
): Promise<PriceWatchInspection> {
  const expectedQuantity = claimExpectedQuantity(claim);
  const result = await (dependencies.enrich || enrichProductTargets)([{
    domain: claim.sourceDomain,
    sourceUrl: claim.canonicalUrl,
    productId: claim.watcherId,
    expectedName: claim.productName,
    expectedType: "Product",
    pairScore: 100,
    role: "rival",
    ...(expectedQuantity ? { expectedQuantity } : {}),
    ...(publicSourceMarketCountryCode(claim.canonicalUrl) ? { marketCountryCode: publicSourceMarketCountryCode(claim.canonicalUrl) } : {}),
  }], 1);
  const product = result.products.find((candidate: ProductRecord) => candidate.id === claim.watcherId) || result.products[0] || null;
  const snapshot = currentPriceSnapshot(product?.priceSignals || []);
  if (product && snapshot) {
    let observedUrl = product.sourceUrl || claim.canonicalUrl;
    try {
      const canonical = canonicalPriceWatchUrl(observedUrl);
      if (canonical.domain !== claim.sourceDomain) return { ok: false, snapshot: null, observedUrl: "", code: "cross-domain-redirect", transient: false };
      observedUrl = canonical.canonicalUrl;
    } catch {
      return { ok: false, snapshot: null, observedUrl: "", code: "invalid-observed-url", transient: false };
    }
    if (claim.baseline?.currency && snapshot.currency !== claim.baseline.currency) return { ok: false, snapshot: null, observedUrl, code: "currency-drift", transient: false };
    if (claim.state === "active" && observedUrl !== (claim.resolvedUrl || claim.canonicalUrl)) return { ok: false, snapshot: null, observedUrl, code: "target-url-drift", transient: false };
    return { ok: true, snapshot, observedUrl, code: "", transient: false };
  }
  const gap = (result.coverage.gaps[0] || {}) as unknown as Record<string, unknown>;
  return {
    ok: false,
    snapshot: null,
    observedUrl: "",
    code: snapshot ? "identity-mismatch" : cleanInspectionCode(gap.code || "missing-price"),
    transient: transientCoverageGap(gap),
  };
}

function cleanInspectionCode(value: unknown) {
  const code = String(value || "price-check-failed").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 80);
  return code || "price-check-failed";
}

export async function processPriceWatchClaim(database: Database.Database, claim: PriceWatchClaim, dependencies: PriceWatchRunnerDependencies = {}) {
  const now = dependencies.now || (() => new Date());
  const inspect = dependencies.inspect || inspectExactPriceWatchTarget;
  const attemptStartedAt = now();
  try {
    if (!beginPriceWatchAttempt(database, claim, attemptStartedAt)) return { watcherId: claim.watcherId, status: "stale" as const };
  } catch {
    releasePriceWatchClaim(database, claim, "pre-attempt-state-failure", now());
    return { watcherId: claim.watcherId, status: "released" as const };
  }
  let first: PriceWatchInspection;
  try {
    first = await inspect(claim);
    if (!first.ok && first.transient) first = await inspect(claim);
  } catch {
    first = { ok: false, snapshot: null, observedUrl: "", code: "inspection-exception", transient: false };
  }
  if (!first.ok || !first.snapshot) {
    completePriceWatchClaim(database, claim, { kind: "failure", code: first.code || "price-check-failed" }, now());
    return { watcherId: claim.watcherId, status: "failed" as const, code: first.code };
  }
  if (claim.state === "baseline_pending" || !claim.baseline) {
    completePriceWatchClaim(database, claim, { kind: "baseline", snapshot: first.snapshot, observedUrl: first.observedUrl }, now());
    return { watcherId: claim.watcherId, status: "baseline" as const };
  }
  if (samePrice(first.snapshot, claim.baseline)) {
    completePriceWatchClaim(database, claim, { kind: "unchanged", snapshot: first.snapshot, observedUrl: first.observedUrl }, now());
    return { watcherId: claim.watcherId, status: "unchanged" as const };
  }
  let confirmation: PriceWatchInspection;
  try { confirmation = await inspect(claim); }
  catch { confirmation = { ok: false, snapshot: null, observedUrl: "", code: "confirmation-exception", transient: false }; }
  if (!confirmation.ok || !confirmation.snapshot) {
    completePriceWatchClaim(database, claim, { kind: "confirmation_inconclusive", code: confirmation.code || "confirmation-failed" }, now());
    return { watcherId: claim.watcherId, status: "confirmation_inconclusive" as const };
  }
  if (samePrice(confirmation.snapshot, first.snapshot)) {
    completePriceWatchClaim(database, claim, { kind: "change", snapshot: first.snapshot, observedUrl: first.observedUrl }, now());
    return { watcherId: claim.watcherId, status: "changed" as const };
  }
  if (samePrice(confirmation.snapshot, claim.baseline)) {
    completePriceWatchClaim(database, claim, { kind: "unchanged", snapshot: claim.baseline, observedUrl: confirmation.observedUrl }, now());
    return { watcherId: claim.watcherId, status: "unchanged" as const };
  }
  completePriceWatchClaim(database, claim, { kind: "confirmation_inconclusive", code: "confirmation-third-price" }, now());
  return { watcherId: claim.watcherId, status: "confirmation_inconclusive" as const };
}

export async function runWithPriceWatchConcurrency<T extends { sourceDomain: string }, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  options: { globalLimit?: number; perDomainLimit?: number } = {},
): Promise<R[]> {
  const globalLimit = Math.max(1, Math.min(8, Math.trunc(options.globalLimit || 8)));
  const perDomainLimit = Math.max(1, Math.min(2, Math.trunc(options.perDomainLimit || 2)));
  const pending = items.map((item, index) => ({ item, index }));
  const results = new Array<R>(items.length);
  const domainActive = new Map<string, number>();
  let active = 0;
  let firstFailure: unknown = null;
  return new Promise((resolve, reject) => {
    const schedule = () => {
      if (firstFailure && active === 0) return reject(firstFailure);
      if (!pending.length && active === 0) return resolve(results);
      let launched = false;
      while (!firstFailure && active < globalLimit) {
        const candidateIndex = pending.findIndex(({ item }) => (domainActive.get(item.sourceDomain) || 0) < perDomainLimit);
        if (candidateIndex < 0) break;
        const [{ item, index }] = pending.splice(candidateIndex, 1);
        launched = true;
        active += 1;
        domainActive.set(item.sourceDomain, (domainActive.get(item.sourceDomain) || 0) + 1);
        void worker(item).then((result) => { results[index] = result; }, (error) => { firstFailure ||= error; }).finally(() => {
          active -= 1;
          domainActive.set(item.sourceDomain, Math.max(0, (domainActive.get(item.sourceDomain) || 1) - 1));
          schedule();
        });
      }
      if (!launched && active === 0 && pending.length && !firstFailure) reject(new Error("Price-watch concurrency scheduler could not make progress."));
    };
    schedule();
  });
}

export async function runPriceWatchBatch(database: Database.Database, dependencies: PriceWatchRunnerDependencies = {}) {
  const now = dependencies.now || (() => new Date());
  const claimOwner = `price-watch:${randomUUID()}`;
  const claims = claimDuePriceWatchers(database, claimOwner, PRICE_WATCH_BATCH_LIMIT, now());
  const results = await runWithPriceWatchConcurrency(claims, (claim) => processPriceWatchClaim(database, claim, dependencies));
  return {
    claimed: claims.length,
    baseline: results.filter((result) => result.status === "baseline").length,
    unchanged: results.filter((result) => result.status === "unchanged").length,
    changed: results.filter((result) => result.status === "changed").length,
    failed: results.filter((result) => result.status === "failed" || result.status === "confirmation_inconclusive").length,
  };
}
