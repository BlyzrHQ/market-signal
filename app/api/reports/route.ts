import { accountContext, type AccountContext } from "../../lib/account-auth.ts";
import { hostedBillingEnabled } from "../../lib/billing-plans.ts";
import {
  createReportCommand,
  publicReportCommandFailure,
  reportCommandDependencies,
  type ReportCommandDependencies,
} from "../../lib/report-command-service.ts";
import { reportStorageDiagnosticCode } from "../../lib/report-store.ts";

type ReportCreationDependencies = ReportCommandDependencies & {
  authorize?: (request: Request) => Promise<AccountContext | null>;
};

export function reportCreationDependencies(environment: Record<string, string | undefined> = process.env): ReportCreationDependencies {
  const dependencies: ReportCreationDependencies = reportCommandDependencies(environment);
  if (!hostedBillingEnabled(environment)) return dependencies;
  return { ...dependencies, authorize: (request) => accountContext(request) };
}

export async function createPersistentReport(request: Request, services: ReportCreationDependencies = reportCreationDependencies()) {
  let stage: "request" | "storage-create" = "request";
  try {
    let account: AccountContext | null = null;
    if (services.authorize) {
      account = await services.authorize(request);
      if (!account) return Response.json({ ok: false, error: "Sign in to create a report.", errorCode: "authentication-required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const body = await request.json() as { primaryDomain?: unknown; locale?: unknown };
    stage = "storage-create";
    const result = await createReportCommand({
      primaryDomain: typeof body.primaryDomain === "string" ? body.primaryDomain : "",
      locale: body.locale === "ar" ? "ar" : "en",
      ...(account ? { actor: { workspaceId: account.workspaceId, userId: account.user.id } } : {}),
    }, services);
    if (result.ok === false) {
      if (result.status === 503) {
        const message = result.errorCode === "dispatch-failed" ? "report job dispatch failed" : "report creation failed";
        console.error(message, { stage: result.stage, diagnosticCode: result.diagnosticCode || result.errorCode });
      }
      return Response.json(publicReportCommandFailure(result), { status: result.status, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: true, report: result.report, job: result.job }, { status: 202, headers: { "Cache-Control": "no-store" } });
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
