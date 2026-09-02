export const MARKET_SIGNAL_LOOP_GRAPH_VERSION = "1" as const;
export const MARKET_SIGNAL_MAX_IMPROVEMENT_ATTEMPTS = 3 as const;

export type MarketSignalLoopNode = {
  id: string;
  kind: "input" | "work" | "output" | "evaluation" | "coding" | "gate" | "state" | "terminal";
  owner: "calling-agent" | "market-signal" | "evaluator" | "coding-agent" | "metric-gate";
  description: string;
};

export type MarketSignalLoopEdge = {
  from: string;
  to: string;
  on: string;
  guard: string | null;
  loopBack: boolean;
};

export const MARKET_SIGNAL_LOOP_GRAPH = {
  id: "market-signal.callable-loop",
  version: MARKET_SIGNAL_LOOP_GRAPH_VERSION,
  maximumImprovementAttempts: MARKET_SIGNAL_MAX_IMPROVEMENT_ATTEMPTS,
  nodes: [
    { id: "input.validate", kind: "input", owner: "market-signal", description: "Validate one typed domain-to-report request." },
    { id: "catalog.crawl", kind: "work", owner: "market-signal", description: "Collect attributable public products from the submitted domain." },
    { id: "comparison.search", kind: "work", owner: "market-signal", description: "Search for rival candidates for the collected products." },
    { id: "candidate.retrieve", kind: "work", owner: "market-signal", description: "Read candidate product pages and source evidence." },
    { id: "comparison.publish", kind: "work", owner: "market-signal", description: "Publish only relevant comparisons with supported prices." },
    { id: "rival.benchmark", kind: "work", owner: "market-signal", description: "Score rivals found in accepted comparisons against the same evidence model." },
    { id: "actions.generate", kind: "work", owner: "market-signal", description: "Generate evidence-grounded next moves." },
    { id: "report.persist", kind: "state", owner: "market-signal", description: "Persist hash-bound facts, report artifacts, and limitations." },
    { id: "output.return", kind: "output", owner: "calling-agent", description: "Return the compact typed result and artifact references." },
    { id: "invocation.end", kind: "terminal", owner: "calling-agent", description: "End the customer invocation without waiting for software improvement." },
    { id: "report.evaluate", kind: "evaluation", owner: "evaluator", description: "Evaluate the terminal report without mutating it." },
    { id: "improvement.observe", kind: "evaluation", owner: "evaluator", description: "Aggregate evidence-linked repeated issues into a candidate proposal." },
    { id: "candidate.implement", kind: "coding", owner: "coding-agent", description: "Create one distinct candidate change from the approved issue." },
    { id: "candidate.validate", kind: "coding", owner: "coding-agent", description: "Run tests, safety checks, and the fixed benchmark suite." },
    { id: "candidate.metric_check", kind: "gate", owner: "metric-gate", description: "Compare the candidate with the stored approved baseline." },
    { id: "candidate.keep", kind: "state", owner: "metric-gate", description: "Promote a measurably better candidate as the next approved version." },
    { id: "candidate.revert", kind: "state", owner: "metric-gate", description: "Restore the approved baseline after a failed candidate." },
    { id: "human.review", kind: "state", owner: "evaluator", description: "Stop on incomparable or uncertain evidence and request judgment." },
    { id: "improvement.end", kind: "terminal", owner: "metric-gate", description: "End the bounded improvement cycle." },
  ] satisfies MarketSignalLoopNode[],
  edges: [
    { from: "input.validate", to: "catalog.crawl", on: "valid", guard: null, loopBack: false },
    { from: "catalog.crawl", to: "comparison.search", on: "catalog_ready", guard: null, loopBack: false },
    { from: "comparison.search", to: "candidate.retrieve", on: "candidates_found", guard: null, loopBack: false },
    { from: "candidate.retrieve", to: "comparison.publish", on: "evidence_ready", guard: null, loopBack: false },
    { from: "comparison.publish", to: "rival.benchmark", on: "priced_comparisons_ready", guard: "emptyPublishedPriceCount = 0", loopBack: false },
    { from: "rival.benchmark", to: "actions.generate", on: "scores_ready", guard: null, loopBack: false },
    { from: "actions.generate", to: "report.persist", on: "report_ready", guard: null, loopBack: false },
    { from: "report.persist", to: "output.return", on: "terminal_saved", guard: null, loopBack: false },
    { from: "output.return", to: "invocation.end", on: "returned", guard: null, loopBack: false },
    { from: "report.persist", to: "report.evaluate", on: "terminal_saved", guard: null, loopBack: false },
    { from: "report.evaluate", to: "improvement.observe", on: "evaluation_saved", guard: null, loopBack: false },
    { from: "improvement.observe", to: "improvement.end", on: "no_approved_candidate", guard: null, loopBack: false },
    { from: "improvement.observe", to: "candidate.implement", on: "candidate_authorized", guard: null, loopBack: false },
    { from: "candidate.implement", to: "candidate.validate", on: "candidate_ready", guard: "candidateHash is distinct", loopBack: false },
    { from: "candidate.validate", to: "candidate.metric_check", on: "checks_complete", guard: null, loopBack: false },
    { from: "candidate.metric_check", to: "candidate.keep", on: "better", guard: "all hard guardrails pass", loopBack: false },
    { from: "candidate.metric_check", to: "candidate.revert", on: "not_better", guard: null, loopBack: false },
    { from: "candidate.metric_check", to: "human.review", on: "incomparable", guard: null, loopBack: false },
    { from: "candidate.keep", to: "improvement.end", on: "versioned", guard: null, loopBack: false },
    { from: "candidate.revert", to: "candidate.implement", on: "retry", guard: "attemptNumber < 3 and next candidateHash is distinct", loopBack: true },
    { from: "candidate.revert", to: "improvement.end", on: "exhausted", guard: "attemptNumber = 3", loopBack: false },
    { from: "human.review", to: "improvement.end", on: "paused", guard: null, loopBack: false },
  ] satisfies MarketSignalLoopEdge[],
} as const;

export function validateMarketSignalLoopGraph() {
  const issues: string[] = [];
  const nodeIds = MARKET_SIGNAL_LOOP_GRAPH.nodes.map((node) => node.id);
  const nodeSet = new Set(nodeIds);
  if (nodeSet.size !== nodeIds.length) issues.push("node ids must be unique");
  for (const edge of MARKET_SIGNAL_LOOP_GRAPH.edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) issues.push(`edge ${edge.from}->${edge.to} references an unknown node`);
  }
  const loopEdges = MARKET_SIGNAL_LOOP_GRAPH.edges.filter((edge) => edge.loopBack);
  if (loopEdges.length !== 1 || loopEdges[0]?.from !== "candidate.revert" || loopEdges[0]?.to !== "candidate.implement") issues.push("the graph must have exactly one declared improvement back-edge");
  if (MARKET_SIGNAL_LOOP_GRAPH.maximumImprovementAttempts !== 3 || loopEdges[0]?.guard !== "attemptNumber < 3 and next candidateHash is distinct") issues.push("the improvement loop must be bounded to three distinct attempts");

  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeIds) adjacency.set(nodeId, []);
  for (const edge of MARKET_SIGNAL_LOOP_GRAPH.edges.filter((candidate) => !candidate.loopBack)) adjacency.get(edge.from)?.push(edge.to);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    if ((adjacency.get(nodeId) || []).some(visit)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  if (nodeIds.some(visit)) issues.push("the graph contains an undeclared cycle");
  return { valid: issues.length === 0, issues };
}
