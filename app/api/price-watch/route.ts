import { accountContext, type AccountContext } from "../../lib/account-auth.ts";
import { hostedBillingEnabled } from "../../lib/billing-plans.ts";
import { openBillingDatabase } from "../../lib/billing-store.ts";
import { PRIVATE_REPORT_HEADERS } from "../../lib/report-access.ts";
import { mutationRequestIsSameOrigin, readBoundedJsonObject } from "../../lib/request-json.ts";
import {
  activatePriceWatchers,
  listPriceWatchers,
  PriceWatchStoreError,
  type PriceWatchActivationInput,
} from "../../lib/price-watch-store.ts";

type PriceWatchRouteDependencies = {
  enabled: () => boolean;
  authorize: (request: Request) => Promise<AccountContext | null>;
  openDatabase: typeof openBillingDatabase;
  now: () => Date;
};

export function priceWatchRouteDependencies(): PriceWatchRouteDependencies {
  return {
    enabled: () => hostedBillingEnabled(process.env),
    authorize: accountContext,
    openDatabase: openBillingDatabase,
    now: () => new Date(),
  };
}

function routeError(error: unknown) {
  if (error instanceof PriceWatchStoreError) {
    return Response.json({ ok: false, error: error.message, errorCode: error.code }, { status: error.httpStatus, headers: PRIVATE_REPORT_HEADERS });
  }
  console.error("Price-watch request failed.", { errorCode: "price-watch-request-failed" });
  return Response.json({ ok: false, error: "Price monitoring is temporarily unavailable.", errorCode: "storage-unavailable" }, { status: 503, headers: PRIVATE_REPORT_HEADERS });
}

export async function getPriceWatch(request: Request, services: PriceWatchRouteDependencies = priceWatchRouteDependencies()) {
  try {
    if (!services.enabled()) return Response.json({ ok: false, error: "Not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    const account = await services.authorize(request);
    if (!account) return Response.json({ ok: false, error: "Authentication required." }, { status: 401, headers: PRIVATE_REPORT_HEADERS });
    const database = await services.openDatabase();
    try {
      return Response.json({ ok: true, ...listPriceWatchers(database, account.workspaceId, services.now()) }, { headers: PRIVATE_REPORT_HEADERS });
    } finally { database.close(); }
  } catch (error) { return routeError(error); }
}

export async function createPriceWatch(request: Request, services: PriceWatchRouteDependencies = priceWatchRouteDependencies()) {
  try {
    if (!services.enabled()) return Response.json({ ok: false, error: "Not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    if (!mutationRequestIsSameOrigin(request)) return Response.json({ ok: false, error: "Invalid request origin.", errorCode: "invalid-origin" }, { status: 403, headers: PRIVATE_REPORT_HEADERS });
    const account = await services.authorize(request);
    if (!account) return Response.json({ ok: false, error: "Authentication required." }, { status: 401, headers: PRIVATE_REPORT_HEADERS });
    let body: PriceWatchActivationInput;
    try { body = await readBoundedJsonObject(request, 4_096) as unknown as PriceWatchActivationInput; } catch { return Response.json({ ok: false, error: "Invalid or oversized JSON body.", errorCode: "invalid-json" }, { status: 400, headers: PRIVATE_REPORT_HEADERS }); }
    const database = await services.openDatabase();
    try {
      const result = activatePriceWatchers(database, account.workspaceId, account.user.id, body, services.now());
      return Response.json({ ok: true, ...result }, { status: 201, headers: PRIVATE_REPORT_HEADERS });
    } finally { database.close(); }
  } catch (error) { return routeError(error); }
}

export async function GET(request: Request) {
  return getPriceWatch(request);
}

export async function POST(request: Request) {
  return createPriceWatch(request);
}
