import {
  MARKET_SIGNAL_FUNCTION_ID,
  MARKET_SIGNAL_FUNCTION_VERSION,
  MARKET_SIGNAL_LOOP_CONTRACT_VERSION,
  type MarketSignalLoopInput,
  type MarketSignalLoopOutput,
  parseMarketSignalLoopInput,
  parseMarketSignalLoopOutput,
} from "./market-signal-loop-contract.ts";

export type MarketSignalLoopPortResult = Omit<MarketSignalLoopOutput, "contractVersion" | "functionId" | "functionVersion" | "requestId" | "primaryDomain" | "productPlan">;

export type MarketSignalLoopPort = {
  run(input: MarketSignalLoopInput): Promise<MarketSignalLoopPortResult>;
};

/**
 * Executes one finite Market Signal function invocation through an injected
 * adapter. The adapter owns the existing durable report workflow. This wrapper
 * validates the caller's input and the exact terminal output but does not add a
 * second retry, billing, or orchestration layer around the report runtime.
 */
export async function callMarketSignalLoop(value: unknown, port: MarketSignalLoopPort): Promise<MarketSignalLoopOutput> {
  const input = parseMarketSignalLoopInput(value);
  const result = await port.run(input);
  if (result.metrics.comparisonTarget !== input.comparisonTarget) throw new Error("Market Signal loop adapter returned a result for a different comparison target.");
  const output = parseMarketSignalLoopOutput({
    ...result,
    contractVersion: MARKET_SIGNAL_LOOP_CONTRACT_VERSION,
    functionId: MARKET_SIGNAL_FUNCTION_ID,
    functionVersion: MARKET_SIGNAL_FUNCTION_VERSION,
    requestId: input.requestId,
    primaryDomain: input.primaryDomain,
    productPlan: input.productPlan,
  });
  return output;
}
