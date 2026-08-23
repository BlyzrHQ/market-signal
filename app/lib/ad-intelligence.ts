// Legacy read compatibility only. New reports do not collect ad-library data.
export type AdPlatform = "Meta" | "Google" | "TikTok";

export function officialAdRecordUrl(value: unknown, platform: AdPlatform) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.toLowerCase();
    const isRecord = platform === "Meta"
      ? host === "facebook.com" && (path === "/ads/library" || path.startsWith("/ads/library/")) && (url.searchParams.has("id") || url.searchParams.has("ad_archive_id"))
      : platform === "Google"
        ? host === "adstransparency.google.com" && path !== "/" && /\/(?:advertiser|creative|ad)\//.test(path)
        : host === "library.tiktok.com" && /\/ads?\/(?:detail|creative|\d)/.test(path) && (url.searchParams.has("ad_id") || /\d{5,}/.test(path));
    return isRecord ? url.toString() : "";
  } catch {
    return "";
  }
}
