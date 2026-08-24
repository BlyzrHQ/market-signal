import { accountContext, type AccountContext } from "./account-auth.ts";
import type { StoredReportAccess } from "./report-store.ts";

export const PRIVATE_REPORT_HEADERS = {
  "cache-control": "private, no-store",
  vary: "Cookie",
} as const;

export const LEGACY_PUBLIC_REPORT_HEADERS = {
  "cache-control": "public, max-age=30, s-maxage=60",
} as const;

export const SHARED_REPORT_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

export type AuthorizedReportAccess =
  | { visibility: "owned-private"; account: AccountContext }
  | { visibility: "legacy-public"; account: null };

export async function authorizeStoredReport(
  request: Request,
  access: StoredReportAccess | null,
  options: {
    authorize?: (request: Request) => Promise<AccountContext | null>;
    now?: Date;
    allowLegacyPublic?: boolean;
  } = {},
): Promise<AuthorizedReportAccess | null> {
  if (!access) return null;
  const now = options.now || new Date();
  const expiry = Date.parse(access.expiresAt);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(expiry) || expiry <= now.getTime()) return null;
  if (!access.workspaceId) return options.allowLegacyPublic === false ? null : { visibility: "legacy-public", account: null };
  const account = await (options.authorize || accountContext)(request);
  return account?.workspaceId === access.workspaceId
    ? { visibility: "owned-private", account }
    : null;
}

export function reportResponseHeaders(access: AuthorizedReportAccess): Record<string, string> {
  return access.visibility === "owned-private"
    ? { ...PRIVATE_REPORT_HEADERS }
    : { ...LEGACY_PUBLIC_REPORT_HEADERS };
}
