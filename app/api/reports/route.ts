import { accountContext, type AccountContext } from "../../lib/account-auth.ts";
import { hostedBillingEnabled } from "../../lib/billing-plans.ts";
import {
  createReportCommand,
  publicReportCommandFailure,
  reportCommandDependencies,
  type ReportCommandDependencies,
} from "../../lib/report-command-service.ts";
import { reportStorageDiagnosticCode } from "../../lib/report-store.ts";
import { reportApiAccountContext } from "../../lib/report-api-auth.ts";

type ReportCreationDependencies = ReportCommandDependencies & {
  authorize?: (request: Request) => Promise<AccountContext | null>;
  authorizeLoop?: (request: Request) => Promise<AccountContext | null>;
  requireAccount?: boolean;
};

export function reportCreationDependencies(environment: Record<string, string | undefined> = process.env): ReportCreationDependencies {
  const dependencies = reportCommandDependencies(environment);
  const loopAuthorization = (request: Request) => reportApiAccountContext(request, environment);
  if (!hostedBillingEnabled(environment)) return {
    ...dependencies,
    authorizeLoop: loopAuthorization,
    requireAccount: false,
  };
  return {
    ...dependencies,
    authorize: accountContext,
    authorizeLoop: loopAuthorization,
    requireAccount: true,
  };
}

export async function createPersistentReport(request: Request, services: ReportCreationDependencies = reportCreationDependencies()) {
  let stage: "request" | "storage-create" = "request";
  try {
    let account: AccountContext | null = null;
    const requiresBrowserAccount = Boolean(services.requireAccount || (services.requireAccount === undefined && services.authorize));
    if (requiresBrowserAccount) {
      account = services.authorize ? await services.authorize(request) : null;
      if (!account) return Response.json({ ok: false, error: "Sign in to create a report.", errorCode: "authentication-required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const body = await request.json() as { primaryDomain?: unknown; locale?: unknown; commandId?: unknown };
    const commandId = typeof body.commandId === "string" ? body.commandId.trim() : "";
    if (commandId && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(commandId)) {
      return Response.json({ ok: false, error: "A valid request id is required.", errorCode: "invalid-request-id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (commandId && !account) {
      const authorize = services.authorizeLoop || services.authorize;
      account = authorize ? await authorize(request) : null;
      if (!account) return Response.json({ ok: false, error: "Sign in to create a report.", errorCode: "authentication-required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    stage = "storage-create";
    const result = await createReportCommand({
      primaryDomain: typeof body.primaryDomain === "string" ? body.primaryDomain : "",
      locale: body.locale === "ar" ? "ar" : "en",
      ...(account ? { actor: { workspaceId: account.workspaceId, userId: account.user.id } } : {}),
      ...(commandId ? { commandId } : {}),
    }, services);
    if (result.ok === false) {
      if (result.status === 503) {
        const message = result.errorCode === "dispatch-failed" ? "report job dispatch failed" : "report creation failed";
        console.error(message, { stage: result.stage, diagnosticCode: result.diagnosticCode || result.errorCode });
      }
      return Response.json(publicReportCommandFailure(result), { status: result.status, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: true, requestId: commandId || null, replayed: result.replayed, report: result.report, job: result.job }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error("report creation failed", {
      stage,
      diagnosticCode: reportStorageDiagnosticCode(error) || (/storage is unavailable/i.test(message) ? "storage-unavailable" : "storage-operation-failed"),
    });
    return Response.json({ ok: false, error: "The persistent report could not be created.", errorCode: "report-create-failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  return createPersistentReport(request);
}
