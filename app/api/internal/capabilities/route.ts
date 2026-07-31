import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../lib/internal-auth.ts";
import { createWorkerApiManifest } from "../../../../src/shared/worker-api-contract.ts";
import { runtimeEnvironmentValue } from "../../../lib/runtime-env.ts";

export function createWorkerCapabilitiesHandler(expectedToken?: string, now: () => Date = () => new Date(), expectedEvaluationToken?: string) {
  return async function GET(request: Request) {
    const authorization = request.headers.get("authorization");
    const evaluationToken = await runtimeEnvironmentValue("MARKET_SIGNAL_EVALUATION_TOKEN", expectedEvaluationToken);
    if (!await hasValidInternalAuthorization(authorization, expectedToken)
      && !await hasValidInternalAuthorization(authorization, evaluationToken)) return unauthorizedInternalResponse();
    return Response.json(createWorkerApiManifest(now), { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = createWorkerCapabilitiesHandler();
