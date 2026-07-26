import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../lib/internal-auth.ts";
import { createWorkerApiManifest } from "../../../../src/shared/worker-api-contract.ts";

export function createWorkerCapabilitiesHandler(expectedToken?: string, now: () => Date = () => new Date()) {
  return async function GET(request: Request) {
    if (!await hasValidInternalAuthorization(request.headers.get("authorization"), expectedToken)) return unauthorizedInternalResponse();
    return Response.json(createWorkerApiManifest(now), { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = createWorkerCapabilitiesHandler();
