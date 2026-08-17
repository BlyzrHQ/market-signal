type ReportSummary = {
  publicId?: unknown;
};

const PUBLIC_REPORT_ID = /^[a-f0-9]{32}$/i;
const RETURN_ORIGIN = "https://market-signal.invalid";
const UNSAFE_PATH_CHARACTER = /[\\\u0000-\u0020\u007f]/;

export function safeAccountReturnPath(value: unknown) {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return "";
  if (UNSAFE_PATH_CHARACTER.test(value)) return "";

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "";
  }
  if (decoded.startsWith("//") || UNSAFE_PATH_CHARACTER.test(decoded)) return "";

  const parsed = new URL(value, RETURN_ORIGIN);
  if (parsed.origin !== RETURN_ORIGIN || parsed.pathname === "/account") return "";
  const result = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return result.startsWith("/") && !result.startsWith("//") ? result : "";
}

export function newestAccountReportPath(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const reports = (payload as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) return "";
  const newest = reports.find((report): report is ReportSummary => Boolean(
    report && typeof report === "object" && !Array.isArray(report) && PUBLIC_REPORT_ID.test(String((report as ReportSummary).publicId || "")),
  ));
  return newest ? `/reports/${String(newest.publicId)}?view=products` : "";
}
