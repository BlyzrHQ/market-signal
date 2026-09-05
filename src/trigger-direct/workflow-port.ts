import { randomBytes } from "node:crypto";
import { handleCrawlRequest } from "../../app/api/crawl/route.ts";
import { createMatchHandler } from "../../app/api/match/route.ts";
import { handleProductEnrichmentRequest } from "../../app/api/enrich-products/route.ts";
import { buildAIProductActions, deterministicProductActionResult } from "../../app/lib/ai-action-planner.ts";
import { parseActionInputs } from "../../app/api/actions/route.ts";
import { buildDirectProductSearchComparison } from "../../app/lib/direct-product-search.ts";
import { searchDirectProductPages } from "../../app/lib/competitor-discovery.ts";
import { enrichProductTargets } from "../../app/lib/storefront-product-enrichment.ts";
import { limitPublishedProductComparison } from "../../app/lib/product-match-lifecycle.ts";
import { canonicalDomain } from "../../app/lib/domain.ts";
import type { ReportOrchestrationPort } from "../trigger/report-orchestration-core.ts";
import { acceptedParkedDomainResponse, acceptedUnavailableDomainResponse, acceptedCrawlFailureError } from "../trigger/report-orchestration-http.ts";
import { WorkflowStore, hash } from "./workflow-state.ts";

function localRequest(payload: unknown, token?: string) {
  // This is an in-process handler call, never a network request or VPS URL.
  return new Request("http://internal.invalid/", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
}
async function json<T>(response: Response): Promise<T> {
  const result = await response.json();
  if (!response.ok && result?.code !== "unavailable-domain" && result?.code !== "parked-domain") throw new Error(`RESEARCH_STAGE_FAILED: ${result?.errorCode || result?.code || response.status}`);
  return result as T;
}
export async function crawlResponse(response: Response, domain: string): Promise<Awaited<ReturnType<ReportOrchestrationPort["crawl"]>>> {
  if (!response.ok) {
    const parked = await acceptedParkedDomainResponse(response.clone(), domain);
    if (parked !== undefined) return parked as Awaited<ReturnType<ReportOrchestrationPort["crawl"]>>;
    const unavailable = await acceptedUnavailableDomainResponse(response.clone(), domain);
    if (unavailable !== undefined) return unavailable as Awaited<ReturnType<ReportOrchestrationPort["crawl"]>>;
    const failure = await acceptedCrawlFailureError(response.clone(), domain);
    if (failure) throw failure;
    throw new Error(`CRAWL_STAGE_FAILED: HTTP ${response.status}`);
  }
  const result = await json<Awaited<ReturnType<ReportOrchestrationPort["crawl"]>>>(response);
  if (result.ok !== true || result.primaryDomain !== domain) throw new Error("INVALID_CRAWL_RESULT");
  return result;
}
export function durableActionFetch(store: WorkflowStore, fetcher: typeof fetch = fetch): typeof fetch {
  return async (url, init) => {
    // Persist each provider request, not only the outer planner. The planner
    // has its own retry loop, which must never rebill an uncertain response.
    const receipt = await store.operation(`action-provider:${hash({ url: String(url), body: String(init?.body || "") })}`, async () => {
      const response = await fetcher(url, init);
      if (!response.ok) throw new Error("ACTION_PROVIDER_RESPONSE_UNCERTAIN");
      const body = await response.text();
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error("ACTION_PROVIDER_RESPONSE_TOO_LARGE");
      JSON.parse(body);
      return { status: response.status, body };
    });
    return new Response(receipt.body, { status: receipt.status, headers: { "content-type": "application/json" } });
  };
}
export function createWorkflowPort(store: WorkflowStore, research: {
  crawl?: ReportOrchestrationPort["crawl"];
  search?: typeof searchDirectProductPages;
  enrich?: typeof enrichProductTargets;
  actions?: typeof buildAIProductActions;
} = {}): ReportOrchestrationPort {
  const token = randomBytes(32).toString("hex");
  let leaseOwner = "";
  let retainedRivalDomains: string[] = [];
  const handler = createMatchHandler({
    loadEntitlement: async (id, attempt) => { store.identity(id, attempt); const run = store.read().report.run; return { plan: "starter", productLimit: run.productLimit!, reportObservedAt: run.createdAt }; },
    loadCheckpoints: async (id, input) => await store.loadCheckpoints(id, input) as ReturnType<WorkflowStore["read"]>["checkpoints"],
    saveCheckpoint: (id, input) => store.saveCheckpoint(id, input),
    replaceCheckpoint: (id, input) => store.saveCheckpoint(id, input),
    acquireLease: async (id, input) => { store.identity(id, input.attemptNumber); const expiresAt = new Date(Date.now() + input.ttlMs).toISOString(); if (leaseOwner) return { acquired: false, expiresAt }; leaseOwner = input.owner; return { acquired: true, expiresAt }; },
    releaseLease: async (id, input) => { store.identity(id, input.attemptNumber); if (leaseOwner === input.owner) leaseOwner = ""; },
    buildDirect: (domain, catalogs, options) => buildDirectProductSearchComparison(domain, catalogs, { ...options,
      concurrency: 8,
      enforceCompatibility: true,
      requestPrimaryCurrency: true,
      maxRivalDomains: store.read().request.rivals,
      admittedRivalDomains: retainedRivalDomains,
      search: (...args) => {
        // A full seller allocation makes another unrestricted seller search
        // wasteful. Repairs ask for new product pages within that allocation.
        const scope = args[3] && retainedRivalDomains.length >= store.read().request.rivals
          ? { allowedRivalDomains: [...retainedRivalDomains].sort() } : {};
        return store.operation(`search:${hash(scope.allowedRivalDomains ? { args, scope } : args)}`, async () => {
        const result = await (research.search || searchDirectProductPages)(...args, scope);
        if (!result.completed) throw new Error("PROVIDER_SEARCH_INCOMPLETE: uncertain result; further paid work stopped");
        return result;
        });
      },
      enrich: research.enrich,
    }),
  }, token);
  const crawl: ReportOrchestrationPort["crawl"] = async (input) => {
    store.assertHealthy();
    return store.operation(`crawl:${hash(input)}`, async () => research.crawl ? research.crawl(input) : crawlResponse(await handleCrawlRequest(localRequest(input), { rememberedCompetitors: false }), input.primary));
  };
  return {
    skipRivalBenchmark: store.read().request.includeAnalysis === false,
    rivalBenchmarkConcurrency: 5,
    constrainPublishedComparison: (comparison) => {
      const counts = new Map<string, number>();
      for (const row of comparison.rows) for (const match of row.matches) if (match.product && match.publication?.priceEligible === true) {
        const domain = canonicalDomain(match.product.domain); counts.set(domain, (counts.get(domain) || 0) + 1);
      }
      retainedRivalDomains = [...counts].sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b)).slice(0, store.read().request.rivals).map(([domain]) => domain);
      const rows = comparison.rows.map((row) => ({ ...row, matches: row.matches.filter((match) => match.product && retainedRivalDomains.includes(canonicalDomain(match.product.domain))) })).filter((row) => row.matches.length);
      return limitPublishedProductComparison({ ...comparison, rows, comparisonDomains: retainedRivalDomains }, store.read().request.comparisons, "pairs");
    },
    preflight: async () => { store.assertHealthy(); if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("SEARCH_NOT_CONFIGURED"); },
    loadReport: async (id) => { store.identity(id); return store.read().report; },
    appendEvent: store.appendEvent,
    crawl, benchmark: crawl,
    brief: async () => { throw new Error("Legacy brief is not part of the current website report workflow"); },
    match: async (input) => { store.assertHealthy(); return json(await handler(localRequest(input, token))); },
    enrich: async (input) => { store.assertHealthy(); return research.enrich ? { ok: true, ...await research.enrich(input.targets as Parameters<typeof enrichProductTargets>[0], 64) } : json(await handleProductEnrichmentRequest(localRequest(input))); },
    actions: async (input) => {
      // Local validation is not an uncertain provider call. In particular the
      // shared engine can retain its deterministic fallback above 480 inputs.
      const inputs = parseActionInputs(input.inputs);
      if (store.read().request.includeAnalysis === false) return { ok: true, result: deterministicProductActionResult(inputs, undefined, ["AI action planning was not requested; deterministic guidance only."]) };
      return { ok: true, result: await store.operation(`actions:${hash(input)}`, () => (research.actions || buildAIProductActions)(inputs, { fetch: durableActionFetch(store), concurrency: 4 })) };
    },
    loadCheckpoint: store.loadCheckpoints,
    saveCheckpoint: async (id, input) => { await store.saveCheckpoint(id, input); },
    persistFactChunk: store.persistFactChunk,
    finalizeFactManifest: store.finalizeFactManifest,
    saveDocument: store.saveDocument,
  };
}
