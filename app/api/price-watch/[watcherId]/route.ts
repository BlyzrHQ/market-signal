import { accountContext, type AccountContext } from "../../../lib/account-auth.ts";
import { hostedBillingEnabled } from "../../../lib/billing-plans.ts";
import { openBillingDatabase } from "../../../lib/billing-store.ts";
import { PRIVATE_REPORT_HEADERS } from "../../../lib/report-access.ts";
import { mutationRequestIsSameOrigin, readBoundedJsonObject } from "../../../lib/request-json.ts";
import {
  deletePriceWatcher,
  mutatePriceWatcher,
  priceWatchHistory,
  PriceWatchStoreError,
  type PriceWatchMutation,
} from "../../../lib/price-watch-store.ts";

type RouteContext = { params: Promise<{ watcherId: string }> | { watcherId: string } };
type WatcherRouteDependencies = {
  enabled: () => boolean;
  authorize: (request: Request) => Promise<AccountContext | null>;
  openDatabase: typeof openBillingDatabase;
  now: () => Date;
};

function dependencies(): WatcherRouteDependencies {
  return { enabled: () => hostedBillingEnabled(process.env), authorize: accountContext, openDatabase: openBillingDatabase, now: () => new Date() };
}

function failure(error: unknown) {
  if (error instanceof PriceWatchStoreError) return Response.json({ ok: false, error: error.message, errorCode: error.code }, { status: error.httpStatus, headers: PRIVATE_REPORT_HEADERS });
  console.error("Price-watcher mutation failed.", { errorCode: "price-watcher-mutation-failed" });
  return Response.json({ ok: false, error: "Price monitoring is temporarily unavailable.", errorCode: "storage-unavailable" }, { status: 503, headers: PRIVATE_REPORT_HEADERS });
}

async function accountFor(request: Request, services: WatcherRouteDependencies) {
  if (!services.enabled()) return null;
  return services.authorize(request);
}

export async function getPriceWatchHistory(request: Request, context: RouteContext, services: WatcherRouteDependencies = dependencies()) {
  try {
    const account = await accountFor(request, services);
    if (!account) return Response.json({ ok: false, error: "Not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    const { watcherId } = await context.params;
    const limit = Number(new URL(request.url).searchParams.get("limit") || 100);
    const database = await services.openDatabase();
    try { return Response.json({ ok: true, history: priceWatchHistory(database, account.workspaceId, watcherId, limit) }, { headers: PRIVATE_REPORT_HEADERS }); }
    finally { database.close(); }
  } catch (error) { return failure(error); }
}

export async function patchPriceWatcher(request: Request, context: RouteContext, services: WatcherRouteDependencies = dependencies()) {
  try {
    if (!mutationRequestIsSameOrigin(request)) return Response.json({ ok: false, error: "Invalid request origin.", errorCode: "invalid-origin" }, { status: 403, headers: PRIVATE_REPORT_HEADERS });
    const account = await accountFor(request, services);
    if (!account) return Response.json({ ok: false, error: "Not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    let body: PriceWatchMutation;
    try { body = await readBoundedJsonObject(request, 2_048) as unknown as PriceWatchMutation; } catch { return Response.json({ ok: false, error: "Invalid or oversized JSON body.", errorCode: "invalid-json" }, { status: 400, headers: PRIVATE_REPORT_HEADERS }); }
    const { watcherId } = await context.params;
    const database = await services.openDatabase();
    try { return Response.json({ ok: true, ...mutatePriceWatcher(database, account.workspaceId, account.user.id, watcherId, body, services.now()) }, { headers: PRIVATE_REPORT_HEADERS }); }
    finally { database.close(); }
  } catch (error) { return failure(error); }
}

export async function removePriceWatcher(request: Request, context: RouteContext, services: WatcherRouteDependencies = dependencies()) {
  try {
    if (!mutationRequestIsSameOrigin(request)) return Response.json({ ok: false, error: "Invalid request origin.", errorCode: "invalid-origin" }, { status: 403, headers: PRIVATE_REPORT_HEADERS });
    const account = await accountFor(request, services);
    if (!account) return Response.json({ ok: false, error: "Not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    const { watcherId } = await context.params;
    const database = await services.openDatabase();
    try { return Response.json({ ok: true, deleted: deletePriceWatcher(database, account.workspaceId, account.user.id, watcherId, services.now()) }, { headers: PRIVATE_REPORT_HEADERS }); }
    finally { database.close(); }
  } catch (error) { return failure(error); }
}

export async function GET(request: Request, context: RouteContext) { return getPriceWatchHistory(request, context); }
export async function PATCH(request: Request, context: RouteContext) { return patchPriceWatcher(request, context); }
export async function DELETE(request: Request, context: RouteContext) { return removePriceWatcher(request, context); }
