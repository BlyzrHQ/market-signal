export type ProductAnalyticsPayloads = {
  landing_viewed: { locale: "en" | "ar" };
  report_requested: { locale: "en" | "ar"; input_kind: "domain" | "url" };
  report_request_failed: { locale: "en" | "ar"; failure_stage: "validation" | "request" | "dispatch" | "processing" };
  report_viewed: { report_status: ReportAnalyticsStatus; plan_key: ReportAnalyticsPlan; has_competitors: boolean; has_product_matches: boolean };
  report_section_viewed: { section: ReportAnalyticsSection; layout: ReportAnalyticsLayout; report_status: ReportAnalyticsStatus; plan_key: ReportAnalyticsPlan };
  report_exported: { format: "csv"; section: "products"; plan_key: ReportAnalyticsPlan };
  report_shared: { share_method: "native" | "clipboard" | "fallback"; section: "products"; plan_key: ReportAnalyticsPlan };
};

export type ProductAnalyticsEventName = keyof ProductAnalyticsPayloads;
export type ReportAnalyticsStatus = "queued" | "running" | "complete" | "limited" | "failed" | "interrupted" | "unknown";
export type ReportAnalyticsPlan = "starter" | "solo" | "growth" | "agency" | "unknown";
export type ReportAnalyticsSection = "competitors" | "products" | "overview";
export type ReportAnalyticsLayout = "none" | "table" | "matchups" | "opportunities";
export type ProductAnalyticsValue = string | boolean | number;
export type ProductAnalyticsEnvelope = { event: ProductAnalyticsEventName; properties: Record<string, ProductAnalyticsValue> };

const EVENT_NAMES = new Set<ProductAnalyticsEventName>([
  "landing_viewed",
  "report_requested",
  "report_request_failed",
  "report_viewed",
  "report_section_viewed",
  "report_exported",
  "report_shared",
]);
const LOCALES = new Set(["en", "ar"]);
const INPUT_KINDS = new Set(["domain", "url"]);
const FAILURE_STAGES = new Set(["validation", "request", "dispatch", "processing"]);
const REPORT_STATUSES = new Set(["queued", "running", "complete", "limited", "failed", "interrupted", "unknown"]);
const PLAN_KEYS = new Set(["starter", "solo", "growth", "agency", "unknown"]);
const SECTIONS = new Set(["competitors", "products", "overview"]);
const LAYOUTS = new Set(["none", "table", "matchups", "opportunities"]);
const SHARE_METHODS = new Set(["native", "clipboard", "fallback"]);

// PostHog adds these low-cardinality SDK fields after capture. Paths, hosts,
// URLs, referrers, campaign strings, user properties, and arbitrary fields are
// intentionally excluded from this final transport allowlist.
const SAFE_POSTHOG_CONTEXT = new Set([
  "$lib",
  "$lib_version",
  "$browser",
  "$browser_version",
  "$os",
  "$os_version",
  "$device_type",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
  "$cookieless_mode",
  "$session_id",
  "$window_id",
  "distinct_id",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function enumValue(value: unknown, allowed: Set<string>, fallback?: string): string | null {
  return typeof value === "string" && allowed.has(value) ? value : fallback ?? null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function compact(properties: Record<string, ProductAnalyticsValue | null>): Record<string, ProductAnalyticsValue> {
  return Object.fromEntries(Object.entries(properties).filter((entry): entry is [string, ProductAnalyticsValue] => entry[1] !== null));
}

export function buildProductAnalyticsEvent<N extends ProductAnalyticsEventName>(name: N, unsafeProperties: ProductAnalyticsPayloads[N] | Record<string, unknown>): ProductAnalyticsEnvelope | null {
  if (!EVENT_NAMES.has(name)) return null;
  const properties = record(unsafeProperties);
  switch (name) {
    case "landing_viewed":
      return { event: name, properties: compact({ locale: enumValue(properties.locale, LOCALES) }) };
    case "report_requested":
      return { event: name, properties: compact({ locale: enumValue(properties.locale, LOCALES), input_kind: enumValue(properties.input_kind, INPUT_KINDS) }) };
    case "report_request_failed":
      return { event: name, properties: compact({ locale: enumValue(properties.locale, LOCALES), failure_stage: enumValue(properties.failure_stage, FAILURE_STAGES) }) };
    case "report_viewed":
      return { event: name, properties: compact({ report_status: enumValue(properties.report_status, REPORT_STATUSES, "unknown"), plan_key: enumValue(properties.plan_key, PLAN_KEYS, "unknown"), has_competitors: booleanValue(properties.has_competitors), has_product_matches: booleanValue(properties.has_product_matches) }) };
    case "report_section_viewed":
      return { event: name, properties: compact({ section: enumValue(properties.section, SECTIONS), layout: enumValue(properties.layout, LAYOUTS, "none"), report_status: enumValue(properties.report_status, REPORT_STATUSES, "unknown"), plan_key: enumValue(properties.plan_key, PLAN_KEYS, "unknown") }) };
    case "report_exported":
      return { event: name, properties: compact({ format: properties.format === "csv" ? "csv" : null, section: properties.section === "products" ? "products" : null, plan_key: enumValue(properties.plan_key, PLAN_KEYS, "unknown") }) };
    case "report_shared":
      return { event: name, properties: compact({ share_method: enumValue(properties.share_method, SHARE_METHODS), section: properties.section === "products" ? "products" : null, plan_key: enumValue(properties.plan_key, PLAN_KEYS, "unknown") }) };
  }
}

export function sanitizePostHogEvent(unsafeEvent: unknown): Record<string, unknown> | null {
  const source = record(unsafeEvent);
  const eventName = typeof source.event === "string" && EVENT_NAMES.has(source.event as ProductAnalyticsEventName) ? source.event as ProductAnalyticsEventName : null;
  if (!eventName) return null;
  const sourceProperties = record(source.properties);
  const envelope = buildProductAnalyticsEvent(eventName, sourceProperties);
  if (!envelope) return null;
  const context = Object.fromEntries(Object.entries(sourceProperties).filter(([key, value]) => SAFE_POSTHOG_CONTEXT.has(key) && (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))));
  return {
    ...(typeof source.uuid === "string" ? { uuid: source.uuid } : {}),
    ...(source.timestamp instanceof Date ? { timestamp: source.timestamp } : {}),
    event: envelope.event,
    properties: { ...context, ...envelope.properties },
  };
}

export function reportAnalyticsStatus(value: unknown): ReportAnalyticsStatus {
  return enumValue(value, REPORT_STATUSES, "unknown") as ReportAnalyticsStatus;
}

export function reportAnalyticsPlan(value: unknown): ReportAnalyticsPlan {
  return enumValue(value, PLAN_KEYS, "unknown") as ReportAnalyticsPlan;
}
