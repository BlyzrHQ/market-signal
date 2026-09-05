import { WorkflowStore } from "./workflow-state.ts";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function productRecord(fact: RecordValue) {
  return { ...record(fact.metadata), id: fact.productId, domain: fact.domain, name: fact.name, normalizedName: fact.normalizedName,
    sourceUrl: fact.sourceUrl, imageUrl: fact.imageUrl, observedAt: fact.observedAt, priceSignals: fact.prices };
}
// Read the authoritative fact set, not the compacted UI's first few rows.
export function workflowOutput(store: WorkflowStore) {
  const state = store.read();
  const manifest = state.report.factManifest;
  const facts = (kind: "companies" | "products" | "matches") => state.chunks.filter((chunk) => chunk.manifestId === manifest?.manifestId && chunk.kind === kind).flatMap((chunk) => chunk.items);
  const products = facts("products");
  const byProduct = new Map(products.map((product) => [`${product.domain}\n${product.productId}`, product]));
  const comparisons = facts("matches").flatMap((match) => {
    const primary = byProduct.get(`${state.request.domain}\n${match.primaryProductId}`);
    const rival = byProduct.get(`${match.rivalDomain}\n${match.rivalProductId}`);
    const evidence = record(match.evidence);
    if (!primary || !rival || record(evidence.publication).priceEligible !== true || !Array.isArray(primary.prices) || !primary.prices.length || !Array.isArray(rival.prices) || !rival.prices.length) return [];
    return [{ primaryProduct: productRecord(primary), rivalProduct: productRecord(rival), assessment: { verdict: match.verdict, confidence: match.confidence, claimType: match.claimType, model: match.model, ...evidence }, recommendation: record(evidence.decision).actionPlan || null }];
  });
  const domains = [...new Set(comparisons.map((pair) => String(pair.rivalProduct.domain)))];
  if (domains.length > state.request.rivals || comparisons.length > state.request.comparisons) throw new Error("PUBLICATION_LIMIT_CONFLICT");
  const document = record(record(state.document).document);
  const blocks = Array.isArray(document.blocks) ? document.blocks.map(record) : [];
  const qualityEvents = state.report.events.filter((event) => event.phase === "quality");
  const evaluation = qualityEvents.at(-1)?.metadata || null;
  const status = state.report.run.status;
  return {
    contractVersion: "1", request: state.request,
    status: status === "complete" && comparisons.length < state.request.comparisons ? "limited" : status,
    startedAt: state.report.run.createdAt, completedAt: state.report.run.updatedAt,
    comparisons,
    competitors: domains.map((domain) => ({ ...facts("companies").find((company) => company.domain === domain), domain, comparisonCount: comparisons.filter((pair) => pair.rivalProduct.domain === domain).length })),
    metrics: { requestedComparisons: state.request.comparisons, pricedComparisons: comparisons.length, competitors: domains.length,
      catalogProducts: products.filter((product) => product.domain === state.request.domain).length,
      completedProviderOperations: Object.values(state.operations).filter((operation) => operation.status === "complete").length },
    evaluation: { basis: "deterministic-report-quality-gate", result: evaluation, events: qualityEvents },
    benchmarks: blocks.filter((block) => block.type === "experience-benchmark"),
    report: state.document, facts: { manifest, companies: facts("companies"), products, matches: facts("matches") },
    progress: state.report.events,
    diagnostics: {
      elapsedMs: Math.max(0, Date.parse(state.report.run.updatedAt) - Date.parse(state.report.run.createdAt)),
      stateRevisions: state.revision,
      operations: Object.values(state.operations).map(operation => ({ kind: operation.kind || "legacy-unknown", status: operation.status,
        startedAt: operation.startedAt || null, completedAt: operation.completedAt || null, durationMs: operation.durationMs ?? null,
        providerUsage: record(operation.result).providerUsage || null })),
      note: "Provider token/tool receipts are usage evidence, not a settled invoice. Legacy runs without receipts remain unknown.",
    },
    limitations: ["Public-source search matches are inferred alternatives, not independent exact-product certification.",
      "The website's research engine runs inside Trigger; network access can differ from the VPS.",
      "Cross-report competitor memory is not enabled. Trigger retention limits apply to checkpoints and results.",
      "AI provider cost is unknown; null must never be interpreted as zero."],
    costMicrousd: null,
  };
}
