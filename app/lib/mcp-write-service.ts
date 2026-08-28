import type Database from "better-sqlite3";
import { activeWorkspacePlan, ensureBillingSchema, getWorkspaceSubscription, hasReportCommandReservation, workspaceUsage } from "./billing-store.ts";
import { canonicalDomain } from "./domain.ts";
import {
  canonicalMcpJson,
  claimMcpConfirmation,
  completeMcpConfirmation,
  consumeMcpRateLimit,
  ensureMcpCommandSchema,
  issueMcpConfirmation,
  McpCommandStoreError,
  recordMcpCommandAudit,
  type McpCommandPrincipal,
} from "./mcp-command-store.ts";
import { MARKET_SIGNAL_ORIGIN } from "./mcp-oauth-shared.ts";
import { openMcpOAuthDatabase } from "./mcp-oauth-store.ts";
import { createReportCommand, type ReportCommandResult } from "./report-command-service.ts";
import {
  activatePriceWatchers,
  deletePriceWatcher,
  mutatePriceWatcher,
  previewPriceWatchActivation,
  previewPriceWatchDelete,
  previewPriceWatchMutation,
  priceWatchUsage,
  PriceWatchStoreError,
  type PriceWatchActivationInput,
  type PriceWatchMutation,
  type PriceWatcher,
} from "./price-watch-store.ts";

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const REPORT_CONFIRM_TOOL = "report_create_confirm";
const PRICE_WATCH_CONFIRM_TOOL = "price_watch_confirm";
const PRICE_WATCH_UPDATE_CONFIRM_TOOL = "price_watch_update_confirm";
const PRICE_WATCH_DELETE_CONFIRM_TOOL = "price_watch_delete_confirm";

export type McpWritePrincipal = McpCommandPrincipal;

export type McpWriteServiceDependencies = {
  openDatabase: typeof openMcpOAuthDatabase;
  createReport: typeof createReportCommand;
  now: () => Date;
};

export class McpWriteServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpWriteServiceError";
    this.code = code;
  }
}

export function mcpWriteServiceDependencies(): McpWriteServiceDependencies {
  return {
    openDatabase: openMcpOAuthDatabase,
    createReport: createReportCommand,
    now: () => new Date(),
  };
}

function ensureWriteSchema(database: Database.Database) {
  ensureBillingSchema(database);
  ensureMcpCommandSchema(database);
}

async function withDatabase<T>(services: McpWriteServiceDependencies, operation: (database: Database.Database) => T | Promise<T>) {
  const database = await services.openDatabase();
  try {
    ensureWriteSchema(database);
    return await operation(database);
  } finally {
    database.close();
  }
}

function normalizedDomain(value: string) {
  const domain = canonicalDomain(value);
  if (!DOMAIN_PATTERN.test(domain)) throw new McpWriteServiceError("invalid-domain", "A valid public domain is required.");
  return domain;
}

function reportImpact(database: Database.Database, principal: McpWritePrincipal, primaryDomain: string, locale: "en" | "ar", now: Date, excludingCommandId = "") {
  const plan = activeWorkspacePlan(database, principal.workspaceId, now);
  const subscription = getWorkspaceSubscription(database, principal.workspaceId);
  if (!plan || !subscription) throw new McpWriteServiceError("subscription-required", "An active paid plan is required to create a report.");
  const usage = workspaceUsage(database, principal.workspaceId, excludingCommandId);
  if (usage.used >= usage.limit) {
    throw new McpWriteServiceError("report-limit-reached", `Your ${plan.name} plan has used all ${usage.limit} reports for this billing period.`);
  }
  return {
    kind: "report-create",
    primaryDomain,
    locale,
    plan: { tier: plan.id, name: plan.name, productComparisonTarget: plan.productLimit },
    reports: { used: usage.used, limit: usage.limit, afterConfirmation: usage.used + 1 },
    billingPeriod: { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd },
  };
}

function safeReportOutcome(result: ReportCommandResult) {
  if (result.ok === false) {
    return {
      ok: false,
      error: { code: result.errorCode, message: result.error },
      ...(result.publicId ? { publicReportId: result.publicId } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
  return {
    ok: true,
    status: "queued",
    report: {
      publicReportId: result.report.publicId,
      primaryDomain: result.report.primaryDomain,
      locale: result.report.locale,
      productComparisonTarget: result.report.productLimit,
      privateUrl: `${MARKET_SIGNAL_ORIGIN}/reports/${result.report.publicId}`,
      expiresAt: result.report.expiresAt,
    },
    job: { dispatched: true },
    pollAfterSeconds: 10,
  };
}

function terminalReplay(outcome: Record<string, unknown>) {
  return { ...outcome, replayed: true };
}

async function complete(
  services: McpWriteServiceDependencies,
  principal: McpWritePrincipal,
  toolName: string,
  commandId: string,
  state: "succeeded" | "failed",
  outcome: Record<string, unknown>,
  errorCode = "",
) {
  return withDatabase(services, (database) => completeMcpConfirmation(database, principal, toolName, commandId, state, outcome, errorCode, services.now()));
}

export async function getMcpAccountStatus(
  principal: McpWritePrincipal,
  grantedScopes: string[],
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  return withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "account:status", 30, 60, now);
    const plan = activeWorkspacePlan(database, principal.workspaceId, now);
    const subscription = getWorkspaceSubscription(database, principal.workspaceId);
    const canSeeReports = grantedScopes.includes("reports:read") || grantedScopes.includes("reports:create");
    const canSeeMonitoring = grantedScopes.includes("price_watch:read") || grantedScopes.includes("price_watch:write");
    const result: Record<string, unknown> = {
      ok: true,
      subscription: plan && subscription ? {
        active: true,
        plan: { tier: plan.id, name: plan.name },
        period: { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd },
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      } : { active: false },
    };
    if (canSeeReports) {
      const usage = workspaceUsage(database, principal.workspaceId);
      result.reports = {
        used: usage.used,
        limit: usage.limit,
        remaining: Math.max(0, usage.limit - usage.used),
        productComparisonTarget: plan?.productLimit || 0,
      };
    }
    if (canSeeMonitoring) {
      const usage = priceWatchUsage(database, principal.workspaceId, now);
      result.monitoring = { allocation: usage.allocation, used: usage.used, remaining: usage.remaining };
    }
    return result;
  });
}

export async function previewMcpReportCreate(
  principal: McpWritePrincipal,
  input: { primaryDomain: string; locale: "en" | "ar" },
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  return withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "report:preview", 20, 60, now);
    const primaryDomain = normalizedDomain(input.primaryDomain);
    const locale = input.locale === "ar" ? "ar" : "en";
    const impact = reportImpact(database, principal, primaryDomain, locale, now);
    const confirmation = issueMcpConfirmation(database, principal, REPORT_CONFIRM_TOOL, { primaryDomain, locale }, impact, now);
    return {
      ok: true,
      confirmationToken: confirmation.confirmationToken,
      expiresAt: confirmation.expiresAt,
      impact,
      message: "Confirming will reserve one report from this billing period and dispatch one private report.",
    };
  });
}

export async function confirmMcpReportCreate(
  principal: McpWritePrincipal,
  confirmationToken: string,
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  const claim = await withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "report:confirm", 10, 60, now);
    return claimMcpConfirmation(database, principal, REPORT_CONFIRM_TOOL, confirmationToken, now);
  });
  if (claim.kind === "terminal") return terminalReplay(claim.outcome);
  if (claim.kind === "in_progress") return { ok: true, status: "in_progress", replayed: true, retryAfterSeconds: 10 };

  try {
    const primaryDomain = normalizedDomain(String(claim.input.primaryDomain || ""));
    const locale = claim.input.locale === "ar" ? "ar" as const : "en" as const;
    const commandStarted = await withDatabase(services, (database) => (
      hasReportCommandReservation(database, principal.workspaceId, claim.commandId)
    ));
    if (!commandStarted) {
      const liveImpact = await withDatabase(services, (database) => (
        reportImpact(database, principal, primaryDomain, locale, services.now(), claim.commandId)
      ));
      if (canonicalMcpJson(liveImpact) !== canonicalMcpJson(claim.impact)) {
        const outcome = { ok: false, error: { code: "impact-changed", message: "Report quota or plan impact changed. Preview the action again." } };
        return await complete(services, principal, REPORT_CONFIRM_TOOL, claim.commandId, "failed", outcome, "impact-changed");
      }
    }
    const result = await services.createReport({
      primaryDomain,
      locale,
      actor: { workspaceId: principal.workspaceId, userId: principal.userId },
      commandId: claim.commandId,
    });
    const outcome = safeReportOutcome(result);
    const succeeded = result.ok === true;
    return await complete(services, principal, REPORT_CONFIRM_TOOL, claim.commandId, succeeded ? "succeeded" : "failed", outcome, succeeded ? "" : result.errorCode);
  } catch (error) {
    const code = error instanceof McpWriteServiceError || error instanceof McpCommandStoreError ? error.code : "temporarily-unavailable";
    const message = error instanceof McpWriteServiceError || error instanceof McpCommandStoreError
      ? error.message
      : "The report command is temporarily unavailable.";
    const outcome = { ok: false, error: { code, message } };
    try { return await complete(services, principal, REPORT_CONFIRM_TOOL, claim.commandId, "failed", outcome, code); } catch { return outcome; }
  }
}

function customerWatcher(watcher: PriceWatcher) {
  const result: Partial<PriceWatcher> = { ...watcher };
  delete result.workspaceId;
  return result;
}

function priceWatchFailure(error: unknown) {
  if (error instanceof PriceWatchStoreError || error instanceof McpWriteServiceError || error instanceof McpCommandStoreError) {
    return { code: error.code, message: error.message };
  }
  return { code: "temporarily-unavailable", message: "The price-watch command is temporarily unavailable." };
}

export async function previewMcpPriceWatchActivation(
  principal: McpWritePrincipal,
  input: PriceWatchActivationInput,
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  return withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "price-watch:preview", 20, 60, now);
    const impact = previewPriceWatchActivation(database, principal.workspaceId, input, now);
    const canonicalInput = {
      publicReportId: impact.publicReportId,
      cadence: impact.cadence,
      ...(impact.selection.kind === "match" ? { matchId: impact.selection.matchId } : { rivalDomain: impact.selection.rivalDomain }),
    };
    const confirmation = issueMcpConfirmation(database, principal, PRICE_WATCH_CONFIRM_TOOL, canonicalInput, impact, now);
    return {
      ok: true,
      confirmationToken: confirmation.confirmationToken,
      expiresAt: confirmation.expiresAt,
      impact,
      message: `Confirming will create or reuse ${impact.uniqueTargets} price ${impact.uniqueTargets === 1 ? "watch" : "watches"} and reserve ${impact.baselineCreditsRequired} baseline ${impact.baselineCreditsRequired === 1 ? "credit" : "credits"}.`,
    };
  });
}

export async function confirmMcpPriceWatchActivation(
  principal: McpWritePrincipal,
  confirmationToken: string,
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  return withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "price-watch:confirm", 10, 60, now);
    const claim = claimMcpConfirmation(database, principal, PRICE_WATCH_CONFIRM_TOOL, confirmationToken, now);
    if (claim.kind === "terminal") return terminalReplay(claim.outcome);
    if (claim.kind === "in_progress") return { ok: true, status: "in_progress", replayed: true, retryAfterSeconds: 10 };
    try {
      const input: PriceWatchActivationInput = {
        publicReportId: String(claim.input.publicReportId || ""),
        cadence: claim.input.cadence === "hourly" ? "hourly" : "daily",
        ...(claim.input.matchId ? { matchId: String(claim.input.matchId) } : { rivalDomain: String(claim.input.rivalDomain || "") }),
      };
      const result = activatePriceWatchers(database, principal.workspaceId, principal.userId, input, now, {
        commandId: claim.commandId,
        operation: "price_watch.activate",
        expectedImpactFingerprint: String(claim.impact.impactFingerprint || ""),
      });
      const outcome = {
        ok: true,
        watcherIds: result.watcherIds,
        created: result.created,
        reused: result.reused,
        baselineCreditsReserved: result.baselineCreditsReserved,
        usage: result.usage,
      };
      return completeMcpConfirmation(database, principal, PRICE_WATCH_CONFIRM_TOOL, claim.commandId, "succeeded", outcome, "", now);
    } catch (error) {
      const failure = priceWatchFailure(error);
      const outcome = { ok: false, error: failure };
      return completeMcpConfirmation(database, principal, PRICE_WATCH_CONFIRM_TOOL, claim.commandId, "failed", outcome, failure.code, now);
    }
  });
}

export async function previewMcpPriceWatchUpdate(
  principal: McpWritePrincipal,
  input: { watcherId: string; cadence?: "hourly" | "daily"; action?: "resume" },
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  return withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "price-watch:update-preview", 20, 60, now);
    const mutation: PriceWatchMutation = { ...(input.cadence ? { cadence: input.cadence } : {}), ...(input.action ? { action: input.action } : {}) };
    const impact = previewPriceWatchMutation(database, principal.workspaceId, input.watcherId, mutation, now);
    const confirmation = issueMcpConfirmation(database, principal, PRICE_WATCH_UPDATE_CONFIRM_TOOL, {
      watcherId: impact.watcherId,
      ...(input.cadence ? { cadence: input.cadence } : {}),
      ...(input.action ? { action: input.action } : {}),
    }, impact, now);
    return {
      ok: true,
      confirmationToken: confirmation.confirmationToken,
      expiresAt: confirmation.expiresAt,
      impact,
      message: `Confirming will ${impact.requested.action === "resume" ? "resume this price watch" : "change this price-watch cadence"} and reserve ${impact.baselineCreditsRequired} baseline ${impact.baselineCreditsRequired === 1 ? "credit" : "credits"}.`,
    };
  });
}

export async function confirmMcpPriceWatchUpdate(
  principal: McpWritePrincipal,
  confirmationToken: string,
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  return withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "price-watch:update-confirm", 10, 60, now);
    const claim = claimMcpConfirmation(database, principal, PRICE_WATCH_UPDATE_CONFIRM_TOOL, confirmationToken, now);
    if (claim.kind === "terminal") return terminalReplay(claim.outcome);
    if (claim.kind === "in_progress") return { ok: true, status: "in_progress", replayed: true, retryAfterSeconds: 10 };
    try {
      const watcherId = String(claim.input.watcherId || "");
      const mutation: PriceWatchMutation = {
        ...(claim.input.cadence === "hourly" || claim.input.cadence === "daily" ? { cadence: claim.input.cadence } : {}),
        ...(claim.input.action === "resume" ? { action: "resume" as const } : {}),
      };
      const result = mutatePriceWatcher(database, principal.workspaceId, principal.userId, watcherId, mutation, now, {
        commandId: claim.commandId,
        operation: "price_watch.update",
        expectedImpactFingerprint: String(claim.impact.impactFingerprint || ""),
      });
      const outcome = { ok: true, watcher: customerWatcher(result.watcher), usage: result.usage };
      return completeMcpConfirmation(database, principal, PRICE_WATCH_UPDATE_CONFIRM_TOOL, claim.commandId, "succeeded", outcome, "", now);
    } catch (error) {
      const failure = priceWatchFailure(error);
      const outcome = { ok: false, error: failure };
      return completeMcpConfirmation(database, principal, PRICE_WATCH_UPDATE_CONFIRM_TOOL, claim.commandId, "failed", outcome, failure.code, now);
    }
  });
}

export async function disableMcpPriceWatch(
  principal: McpWritePrincipal,
  watcherId: string,
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  return withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "price-watch:disable", 30, 60, now);
    const result = mutatePriceWatcher(database, principal.workspaceId, principal.userId, watcherId, { action: "disable" }, now);
    recordMcpCommandAudit(database, principal, { toolName: "price_watch_disable", eventType: "command.succeeded", detail: { state: "disabled" } }, now);
    return { ok: true, watcher: customerWatcher(result.watcher), usage: result.usage };
  });
}

export async function previewMcpPriceWatchDelete(
  principal: McpWritePrincipal,
  watcherId: string,
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  return withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "price-watch:delete-preview", 20, 60, now);
    const impact = previewPriceWatchDelete(database, principal.workspaceId, watcherId);
    const confirmation = issueMcpConfirmation(database, principal, PRICE_WATCH_DELETE_CONFIRM_TOOL, { watcherId }, impact, now);
    return {
      ok: true,
      confirmationToken: confirmation.confirmationToken,
      expiresAt: confirmation.expiresAt,
      impact,
      message: "Confirming permanently removes this watcher, its observation history, report links, watcher notifications, and pending email deliveries. Consumed credits remain charged.",
    };
  });
}

export async function confirmMcpPriceWatchDelete(
  principal: McpWritePrincipal,
  confirmationToken: string,
  services: McpWriteServiceDependencies = mcpWriteServiceDependencies(),
) {
  return withDatabase(services, (database) => {
    const now = services.now();
    consumeMcpRateLimit(database, principal, "price-watch:delete-confirm", 10, 60, now);
    const claim = claimMcpConfirmation(database, principal, PRICE_WATCH_DELETE_CONFIRM_TOOL, confirmationToken, now);
    if (claim.kind === "terminal") return terminalReplay(claim.outcome);
    if (claim.kind === "in_progress") return { ok: true, status: "in_progress", replayed: true, retryAfterSeconds: 10 };
    try {
      const watcherId = String(claim.input.watcherId || "");
      const deleted = deletePriceWatcher(database, principal.workspaceId, principal.userId, watcherId, now, {
        commandId: claim.commandId,
        operation: "price_watch.delete",
        expectedImpactFingerprint: String(claim.impact.impactFingerprint || ""),
      });
      const outcome = { ok: true, watcherId, deleted };
      return completeMcpConfirmation(database, principal, PRICE_WATCH_DELETE_CONFIRM_TOOL, claim.commandId, "succeeded", outcome, "", now);
    } catch (error) {
      const failure = priceWatchFailure(error);
      const outcome = { ok: false, error: failure };
      return completeMcpConfirmation(database, principal, PRICE_WATCH_DELETE_CONFIRM_TOOL, claim.commandId, "failed", outcome, failure.code, now);
    }
  });
}
