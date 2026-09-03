import { accountAuthConfigFromEnvironment, accountContext, type AccountContext } from "./account-auth.ts";
import { hostedBillingEnabled } from "./billing-plans.ts";
import { hasValidApiAuthorization } from "./internal-auth.ts";
import { consumeMcpRateLimit, McpCommandStoreError } from "./mcp-command-store.ts";
import { openMcpOAuthDatabase } from "./mcp-oauth-store.ts";
import { MARKET_SIGNAL_ORIGIN } from "./mcp-oauth-shared.ts";
import { McpAccessTokenError, verifyCliAccessToken } from "./mcp-token-verifier.ts";
import { authorizeReportApiKey, looksLikeReportApiKey } from "./report-api-keys.ts";

export const CONTROLLED_CLI_WORKSPACE_ID = "controlled-cli-workspace";
export const REPORT_API_RESOURCE_METADATA = `${MARKET_SIGNAL_ORIGIN}/.well-known/oauth-protected-resource/api`;

export class ReportApiAuthorizationError extends Error {
  readonly status: 403 | 429 | 503;
  readonly errorCode: "insufficient-scope" | "rate-limit-exceeded" | "authorization-unavailable";

  constructor(status: ReportApiAuthorizationError["status"], errorCode: ReportApiAuthorizationError["errorCode"], message: string) {
    super(message);
    this.name = "ReportApiAuthorizationError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

export function reportApiAuthorizationErrorResponse(error: ReportApiAuthorizationError) {
  return Response.json(
    { ok: false, error: error.message, errorCode: error.errorCode },
    {
      status: error.status,
      headers: {
        "cache-control": "no-store",
        ...(error.status === 429 ? { "retry-after": "60" } : {}),
        ...(error.status === 403 ? {
          "www-authenticate": `Bearer error="insufficient_scope", resource_metadata="${REPORT_API_RESOURCE_METADATA}"`,
        } : {}),
      },
    },
  );
}

export function reportApiAuthenticationRequiredResponse(message = "Sign in to access this report.") {
  return Response.json(
    { ok: false, error: message, errorCode: "authentication-required" },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${REPORT_API_RESOURCE_METADATA}"`,
      },
    },
  );
}

export function reportApiBearerPresented(request: Request) {
  return /^Bearer\s/i.test(request.headers.get("authorization") || "");
}

function bearerToken(value: string | null) {
  if (!value || value.length > 16_400) return "";
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match?.[1] || "";
}

function hostedCliPolicy(request: Request) {
  const url = new URL(request.url);
  const createsReport = request.method === "POST" && url.pathname === "/api/reports";
  return createsReport
    ? { scope: "reports:create" as const, bucket: "cli:reports:create", limit: 6 }
    : { scope: "reports:read" as const, bucket: "cli:reports:read", limit: 120 };
}

/**
 * Resolves a browser account, hosted OAuth/API-key principal, or the
 * single-tenant token used by a self-hosted/controlled deployment. Hosted
 * billing deliberately refuses the shared token because it is not a
 * customer-scoped credential.
 */
export async function reportApiAccountContext(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): Promise<AccountContext | null> {
  const browserAccount = await accountContext(request);
  if (browserAccount) return browserAccount;
  if (hostedBillingEnabled(environment)) {
    const token = bearerToken(request.headers.get("authorization"));
    if (!token) return null;
    const config = accountAuthConfigFromEnvironment(environment);
    // Hosted deployments fail closed when OAuth is not fully configured. This
    // also prevents the deployment-wide controlled-service token from becoming
    // a customer credential by accident.
    if (!config?.mcpEnabled) return null;
    let database: Awaited<ReturnType<typeof openMcpOAuthDatabase>> | undefined;
    try {
      database = await openMcpOAuthDatabase(environment);
      const policy = hostedCliPolicy(request);
      const apiKeyAuthorization = looksLikeReportApiKey(token)
        ? authorizeReportApiKey(database, token, [policy.scope])
        : null;
      if (apiKeyAuthorization?.ok === false) {
        if (apiKeyAuthorization.reason === "insufficient_scope") {
          throw new ReportApiAuthorizationError(403, "insufficient-scope", "The API key does not grant this report operation.");
        }
        return null;
      }
      const authorization = apiKeyAuthorization?.ok
        ? apiKeyAuthorization.context
        : await verifyCliAccessToken(database, token, [policy.scope]);
      try {
        consumeMcpRateLimit(database, {
          workspaceId: authorization.workspaceId,
          userId: authorization.user.id,
          clientId: authorization.clientId,
        }, policy.bucket, policy.limit, 60);
      } catch (error) {
        if (error instanceof McpCommandStoreError && error.code === "rate-limit-exceeded") {
          throw new ReportApiAuthorizationError(429, "rate-limit-exceeded", "Too many CLI requests. Try again shortly.");
        }
        throw error;
      }
      return {
        user: authorization.user,
        workspaceId: authorization.workspaceId,
      };
    } catch (error) {
      if (error instanceof ReportApiAuthorizationError) throw error;
      if (error instanceof McpAccessTokenError) {
        if (error.code === "insufficient_scope") {
          throw new ReportApiAuthorizationError(403, "insufficient-scope", "The CLI login does not grant this report operation.");
        }
        return null;
      }
      throw new ReportApiAuthorizationError(503, "authorization-unavailable", "CLI authorization is temporarily unavailable.");
    } finally {
      database?.close();
    }
  }
  if (!await hasValidApiAuthorization(request.headers.get("authorization"), String(environment.MARKET_SIGNAL_API_TOKEN || ""))) return null;
  return {
    user: { id: "controlled-cli", name: "Controlled CLI", email: "" },
    workspaceId: CONTROLLED_CLI_WORKSPACE_ID,
  };
}
