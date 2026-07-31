import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../lib/internal-auth.ts";
import { purgeExpiredReports, type ReportPurgeResult } from "../../../lib/report-store.ts";

const MAX_RETENTION_BODY_BYTES = 1_024;

type RetentionServices = {
  purge(now?: Date): Promise<ReportPurgeResult>;
};

async function boundedJson(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_RETENTION_BODY_BYTES || !request.body) throw new Error();
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RETENTION_BODY_BYTES) {
      await reader.cancel();
      throw new Error();
    }
    json += decoder.decode(value, { stream: true });
  }
  const value = JSON.parse(json + decoder.decode()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

export function createRetentionHandler(expectedToken?: string, services: RetentionServices = { purge: (now) => purgeExpiredReports(now) }) {
  return async function POST(request: Request) {
    if (!await hasValidInternalAuthorization(request.headers.get("authorization"), expectedToken)) return unauthorizedInternalResponse();
    let body: Record<string, unknown>;
    try {
      body = await boundedJson(request);
    } catch {
      return Response.json({ ok: false, error: "Invalid retention request." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (body.action !== "purge-expired" || Object.keys(body).length !== 1) {
      return Response.json({ ok: false, error: "Unsupported retention action." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    try {
      return Response.json({ ok: true, ...(await services.purge()) }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ ok: false, error: "Expired reports could not be purged." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export const POST = createRetentionHandler();
