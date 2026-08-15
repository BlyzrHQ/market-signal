import { IPV6_ONLY_ORIGIN_REASON } from "./public-fetch.ts";

export async function settleWithConcurrency<Input, Output>(
  inputs: Input[],
  concurrency: number,
  work: (input: Input, index: number) => Promise<Output>,
): Promise<PromiseSettledResult<Output>[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<PromiseSettledResult<Output>>(inputs.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await work(inputs[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => worker()));
  return results;
}

export type PublicEndpointFailure = {
  kind: "network" | "timeout";
  attemptedUrl: string;
  reason: string;
  observedAt: string;
};

export type UnavailablePrimaryState = {
  status: "unavailable";
  attemptedUrl: string;
  reason: string;
  observedAt: string;
};

export function preferredEndpointFailure(first: PublicEndpointFailure, second: PublicEndpointFailure) {
  return first.reason === IPV6_ONLY_ORIGIN_REASON ? first : second;
}

export function unavailableAfterBoundedAttempts(first?: PublicEndpointFailure, second?: PublicEndpointFailure): UnavailablePrimaryState | null {
  if (first?.kind !== "network" || second?.kind !== "network") return null;
  try {
    const firstUrl = new URL(first.attemptedUrl);
    const secondUrl = new URL(second.attemptedUrl);
    if (firstUrl.protocol !== "https:" || secondUrl.protocol !== "https:" || firstUrl.origin !== secondUrl.origin) return null;
    const ipv6OnlyReason = first.reason === IPV6_ONLY_ORIGIN_REASON && second.reason === IPV6_ONLY_ORIGIN_REASON
      ? IPV6_ONLY_ORIGIN_REASON
      : "The submitted public HTTPS endpoint did not return a network response after two bounded attempts.";
    return {
      status: "unavailable",
      attemptedUrl: secondUrl.toString(),
      reason: ipv6OnlyReason,
      observedAt: second.observedAt,
    };
  } catch {
    return null;
  }
}

export function unavailablePrimaryMessaging(domain: string, state: UnavailablePrimaryState) {
  const reason = state.reason.trim() || "The submitted public HTTPS endpoint was unavailable after two bounded attempts.";
  return {
    explanation: `${reason} Competitor, product, advertising, and matching analysis did not run.`,
    summaryBody: `Competitor discovery did not run. ${reason}`,
    error: `${domain}: ${reason}`,
  };
}

function structuredDataFragments(document: string, maxBytes: number) {
  const lower = document.toLowerCase();
  const encoder = new TextEncoder();
  const fragments: string[] = [];
  let used = 0;
  let cursor = 0;
  while (cursor < lower.length) {
    const start = lower.indexOf("<script", cursor);
    if (start < 0) break;
    const openEnd = lower.indexOf(">", start + 7);
    if (openEnd < 0) break;
    const close = lower.indexOf("</script", openEnd + 1);
    if (close < 0) break;
    const closeEnd = lower.indexOf(">", close + 8);
    if (closeEnd < 0) break;
    cursor = closeEnd + 1;
    const openingTag = lower.slice(start, openEnd + 1);
    if (!/\btype\s*=\s*["']?application\/ld\+json\b/i.test(openingTag)) continue;
    const fragment = document.slice(start, closeEnd + 1);
    const size = encoder.encode(fragment).byteLength;
    if (used + size > maxBytes) continue;
    fragments.push(fragment);
    used += size;
  }
  return fragments.join("\n");
}

export function boundedExtractionDocument(document: string, maxBytes: number) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(document);
  const limit = Math.max(1_024, Math.floor(maxBytes));
  if (bytes.byteLength <= limit) return document;

  const structured = structuredDataFragments(document, Math.floor(limit * 0.4));
  const structuredSection = structured ? `\n<!-- retained structured product evidence -->\n${structured}\n` : "";
  const marker = `\n<!-- content omitted from regex extraction; full document retained for hashing -->${structuredSection}\n`;
  const markerBytes = encoder.encode(marker);
  const available = Math.max(0, limit - markerBytes.byteLength);
  const headLength = Math.floor(available * 0.75);
  const tailLength = available - headLength;
  let headEnd = headLength;
  while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = bytes.byteLength - tailLength;
  while (tailStart < bytes.byteLength && (bytes[tailStart] & 0xc0) === 0x80) tailStart += 1;
  const decoder = new TextDecoder();
  return `${decoder.decode(bytes.slice(0, headEnd))}${marker}${decoder.decode(bytes.slice(tailStart))}`;
}

type ReportBlock = Record<string, unknown> & { type: string; id: string };
type ReportDocument = { version: string; blocks: ReportBlock[] } & Record<string, unknown>;

function hasComparableObservedPrice(product: unknown) {
  if (!product || typeof product !== "object") return false;
  const signals = (product as { priceSignals?: unknown }).priceSignals;
  if (!Array.isArray(signals)) return false;
  return signals.some((signal) => {
    if (!signal || typeof signal !== "object") return false;
    const { amount, currency } = signal as { amount?: unknown; currency?: unknown };
    return typeof amount === "number"
      && Number.isFinite(amount)
      && amount > 0
      && typeof currency === "string"
      && currency.trim().length > 0;
  });
}

export function compactCatalogSnapshots<T extends ReportDocument>(document: T, maxProductsPerCatalog = 40): T {
  const limit = Math.max(0, Math.floor(maxProductsPerCatalog));
  return {
    ...document,
    blocks: document.blocks.map((block) => {
      if (block.type !== "product-catalog" || !Array.isArray(block.products)) return block;
      const pricedProducts = block.products.filter(hasComparableObservedPrice);
      const unpricedProducts = block.products.filter((product) => !hasComparableObservedPrice(product));
      const products = [...pricedProducts, ...unpricedProducts].slice(0, limit);
      return {
        ...block,
        products,
        persistedProductCount: products.length,
        totalProductCount: block.products.length,
        pricedProductCount: products.filter(hasComparableObservedPrice).length,
        totalPricedProductCount: pricedProducts.length,
        productsTruncated: block.products.length > limit,
      };
    }),
  };
}

export function interruptedReportRecovery(publicReportId: string, message: string) {
  const safeMessage = message.trim() || "The competitor scan was temporarily interrupted. Run the scan again.";
  return {
    path: `/reports/${encodeURIComponent(publicReportId)}`,
    event: {
      action: "event" as const,
      idempotencyKey: "crawl-request-interrupted",
      phase: "failed" as const,
      status: "failed" as const,
      message: safeMessage,
      errorCode: "crawl-service-interrupted",
    },
  };
}
