import { accountContext, type AccountContext } from "../../../lib/account-auth.ts";
import { hostedBillingEnabled } from "../../../lib/billing-plans.ts";
import { openBillingDatabase } from "../../../lib/billing-store.ts";
import { PRIVATE_REPORT_HEADERS } from "../../../lib/report-access.ts";
import { listWorkspaceNotifications, markWorkspaceNotificationsRead } from "../../../lib/price-watch-store.ts";
import { mutationRequestIsSameOrigin, readBoundedJsonObject } from "../../../lib/request-json.ts";

type NotificationRouteDependencies = {
  enabled: () => boolean;
  authorize: (request: Request) => Promise<AccountContext | null>;
  openDatabase: typeof openBillingDatabase;
  now: () => Date;
};

export function notificationRouteDependencies(): NotificationRouteDependencies {
  return { enabled: () => hostedBillingEnabled(process.env), authorize: accountContext, openDatabase: openBillingDatabase, now: () => new Date() };
}

export async function getPriceWatchNotifications(request: Request, services: NotificationRouteDependencies = notificationRouteDependencies()) {
  try {
    if (!services.enabled()) return Response.json({ ok: false, error: "Not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    const account = await services.authorize(request);
    if (!account) return Response.json({ ok: false, error: "Authentication required." }, { status: 401, headers: PRIVATE_REPORT_HEADERS });
    const database = await services.openDatabase();
    try { return Response.json({ ok: true, ...listWorkspaceNotifications(database, account.workspaceId, account.user.id) }, { headers: PRIVATE_REPORT_HEADERS }); }
    finally { database.close(); }
  } catch {
    return Response.json({ ok: false, error: "Notifications are temporarily unavailable." }, { status: 503, headers: PRIVATE_REPORT_HEADERS });
  }
}

export async function markPriceWatchNotificationsRead(request: Request, services: NotificationRouteDependencies = notificationRouteDependencies()) {
  try {
    if (!services.enabled()) return Response.json({ ok: false, error: "Not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    if (!mutationRequestIsSameOrigin(request)) return Response.json({ ok: false, error: "Invalid request origin." }, { status: 403, headers: PRIVATE_REPORT_HEADERS });
    const account = await services.authorize(request);
    if (!account) return Response.json({ ok: false, error: "Authentication required." }, { status: 401, headers: PRIVATE_REPORT_HEADERS });
    let body: { notificationIds?: string[] };
    try { body = await readBoundedJsonObject(request, 16_384) as { notificationIds?: string[] }; } catch { return Response.json({ ok: false, error: "Invalid or oversized JSON body." }, { status: 400, headers: PRIVATE_REPORT_HEADERS }); }
    const database = await services.openDatabase();
    try { return Response.json({ ok: true, marked: markWorkspaceNotificationsRead(database, account.workspaceId, account.user.id, Array.isArray(body.notificationIds) ? body.notificationIds : [], services.now()) }, { headers: PRIVATE_REPORT_HEADERS }); }
    finally { database.close(); }
  } catch {
    return Response.json({ ok: false, error: "Notifications are temporarily unavailable." }, { status: 503, headers: PRIVATE_REPORT_HEADERS });
  }
}

export async function GET(request: Request) { return getPriceWatchNotifications(request); }
export async function POST(request: Request) { return markPriceWatchNotificationsRead(request); }
