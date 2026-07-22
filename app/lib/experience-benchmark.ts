export type ExperiencePage = {
  sourceUrl: string;
  responseTimeMs?: number;
  responseBytes?: number;
  imageCount?: number;
  imagesWithAlt?: number;
  responsiveImageCount?: number;
  hasViewport?: boolean;
  hasDocumentLanguage?: boolean;
  productLinkCount?: number;
  hasProductPath?: boolean;
  hasAddToCart?: boolean;
  hasCartLink?: boolean;
  hasCheckoutLink?: boolean;
  trustSignals?: string[];
};

export type ExperienceProduct = {
  name?: string;
  description?: string;
  category?: string;
  imageUrl?: string;
  priceSignals?: unknown[];
  quantity?: unknown;
  identifiers?: unknown;
  sourceUrl?: string;
};

export type ExperienceDomain = {
  domain: string;
  role: string;
  fetchedAt: string;
  pages: ExperiencePage[];
  products: ExperienceProduct[];
  catalogProductsDiscovered: number;
};

export type BenchmarkMetric = {
  score: number | null;
  sampleSize: number;
  observed: Record<string, number | boolean | null>;
  formula: string;
  sourceUrls: string[];
};

export type ExperienceBenchmarkDomain = {
  domain: string;
  role: string;
  observedAt: string;
  response: BenchmarkMetric;
  images: BenchmarkMetric;
  information: BenchmarkMetric;
  productAccess: BenchmarkMetric;
  purchasePath: BenchmarkMetric & { minimumPublicSteps: number | null };
  trust: BenchmarkMetric;
  mobileAccessibility: BenchmarkMetric;
};

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const percent = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 100) : null;
const sourceUrls = (pages: ExperiencePage[]) => [...new Set(pages.map((page) => page.sourceUrl).filter(Boolean))];
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

function responseMetric(pages: ExperiencePage[]): BenchmarkMetric {
  const timings = pages.map((page) => page.responseTimeMs).filter((value): value is number => typeof value === "number" && value >= 0);
  const bytes = pages.map((page) => page.responseBytes).filter((value): value is number => typeof value === "number" && value >= 0);
  const medianMs = median(timings);
  const medianBytes = median(bytes);
  return {
    score: null,
    sampleSize: timings.length,
    observed: { medianMs, medianBytes },
    formula: "Median HTML fetch duration from this run. No normalized score is assigned because this crawler-location proxy is not Core Web Vitals or real-user speed.",
    sourceUrls: sourceUrls(pages.filter((page) => typeof page.responseTimeMs === "number")),
  };
}

function imageMetric(pages: ExperiencePage[], products: ExperienceProduct[]): BenchmarkMetric {
  const productsWithImage = products.filter((product) => Boolean(product.imageUrl)).length;
  const imageCount = pages.reduce((sum, page) => sum + (page.imageCount || 0), 0);
  const imagesWithAlt = pages.reduce((sum, page) => sum + (page.imagesWithAlt || 0), 0);
  const responsiveImages = pages.reduce((sum, page) => sum + (page.responsiveImageCount || 0), 0);
  const productCoverage = percent(productsWithImage, products.length);
  const altCoverage = percent(imagesWithAlt, imageCount);
  const responsiveCoverage = percent(responsiveImages, imageCount);
  const available = [productCoverage, altCoverage, responsiveCoverage].filter((value): value is number => value !== null);
  const weighted = productCoverage === null ? null : (productCoverage * 0.6) + ((altCoverage || 0) * 0.25) + ((responsiveCoverage || 0) * 0.15);
  return {
    score: weighted === null ? null : clamp(weighted),
    sampleSize: Math.max(products.length, imageCount),
    observed: { products: products.length, productsWithImage, productImageCoverage: productCoverage, pageImages: imageCount, altCoverage, responsiveCoverage },
    formula: "60% product-image coverage + 25% meaningful alt coverage + 15% responsive-image markup. This is image readiness, not subjective visual quality.",
    sourceUrls: available.length ? sourceUrls(pages) : [],
  };
}

function informationMetric(pages: ExperiencePage[], products: ExperienceProduct[]): BenchmarkMetric {
  if (!products.length) return { score: null, sampleSize: 0, observed: { products: 0, completedFields: null, possibleFields: null }, formula: "Average coverage of six public fields: name, description, price, image, category, and quantity or identifier.", sourceUrls: [] };
  const completedFields = products.reduce((sum, product) => sum
    + Number(Boolean(product.name))
    + Number(Boolean(product.description))
    + Number(Boolean(product.priceSignals?.length))
    + Number(Boolean(product.imageUrl))
    + Number(Boolean(product.category))
    + Number(Boolean(product.quantity || product.identifiers)), 0);
  const possibleFields = products.length * 6;
  return {
    score: clamp((completedFields / possibleFields) * 100),
    sampleSize: products.length,
    observed: { products: products.length, completedFields, possibleFields },
    formula: "Equal-weight average of six public fields: name, description, price, image, category, and quantity or identifier.",
    sourceUrls: [...new Set(products.map((product) => product.sourceUrl).filter((value): value is string => Boolean(value)))].slice(0, 12),
  };
}

function productAccessMetric(pages: ExperiencePage[], catalogProductsDiscovered: number): BenchmarkMetric {
  if (!pages.length) return { score: null, sampleSize: 0, observed: { homepageProductLinks: null, reachedProductPath: false, catalogProductsDiscovered }, formula: "60 points for up to five homepage product/catalog links, 25 for reaching a product path, and 15 for public catalog discovery.", sourceUrls: [] };
  const homepageProductLinks = pages[0]?.productLinkCount || 0;
  const reachedProductPath = pages.some((page) => page.hasProductPath);
  const score = Math.min(homepageProductLinks, 5) / 5 * 60 + Number(reachedProductPath) * 25 + Number(catalogProductsDiscovered > 0) * 15;
  return {
    score: clamp(score),
    sampleSize: pages.length,
    observed: { homepageProductLinks, reachedProductPath, catalogProductsDiscovered },
    formula: "60 points for up to five homepage product/catalog links, 25 for reaching a product path, and 15 for public catalog discovery.",
    sourceUrls: sourceUrls(pages),
  };
}

function purchasePathMetric(pages: ExperiencePage[]): BenchmarkMetric & { minimumPublicSteps: number | null } {
  const hasAddToCart = pages.some((page) => page.hasAddToCart);
  const hasCartLink = pages.some((page) => page.hasCartLink);
  const hasCheckoutLink = pages.some((page) => page.hasCheckoutLink);
  const hasProductPath = pages.some((page) => page.hasProductPath);
  const anySignal = hasAddToCart || hasCartLink || hasCheckoutLink;
  const minimumPublicSteps = hasCheckoutLink ? 1 : hasAddToCart && hasCartLink ? 2 : hasAddToCart ? 3 : hasCartLink ? 2 : null;
  const score = !anySignal ? null : clamp(Number(hasProductPath) * 20 + Number(hasAddToCart) * 35 + Number(hasCartLink) * 20 + Number(hasCheckoutLink) * 25);
  return {
    score,
    minimumPublicSteps,
    sampleSize: pages.length,
    observed: { hasProductPath, hasAddToCart, hasCartLink, hasCheckoutLink },
    formula: "20 product-path points + 35 add-to-cart + 20 cart + 25 checkout. Steps are a minimum public-path estimate, never completed-checkout time.",
    sourceUrls: sourceUrls(pages.filter((page) => page.hasProductPath || page.hasAddToCart || page.hasCartLink || page.hasCheckoutLink)),
  };
}

function trustMetric(pages: ExperiencePage[]): BenchmarkMetric {
  const signals = new Set(pages.flatMap((page) => page.trustSignals || []));
  return {
    score: pages.length ? clamp(signals.size * 20) : null,
    sampleSize: pages.length,
    observed: { shipping: signals.has("shipping"), returns: signals.has("returns"), contact: signals.has("contact"), legal: signals.has("legal"), company: signals.has("company") },
    formula: "20 points each for public shipping, returns/refund, contact, privacy/terms, and company/about/review paths.",
    sourceUrls: sourceUrls(pages),
  };
}

function mobileAccessibilityMetric(pages: ExperiencePage[]): BenchmarkMetric {
  if (!pages.length) return { score: null, sampleSize: 0, observed: { viewport: false, documentLanguage: false, altCoverage: null }, formula: "45 viewport points + 20 document-language points + 35 points scaled by meaningful image alt coverage.", sourceUrls: [] };
  const viewport = pages.some((page) => page.hasViewport);
  const documentLanguage = pages.some((page) => page.hasDocumentLanguage);
  const imageCount = pages.reduce((sum, page) => sum + (page.imageCount || 0), 0);
  const imagesWithAlt = pages.reduce((sum, page) => sum + (page.imagesWithAlt || 0), 0);
  const altCoverage = percent(imagesWithAlt, imageCount);
  const score = Number(viewport) * 45 + Number(documentLanguage) * 20 + (altCoverage === null ? 0 : altCoverage * 0.35);
  return {
    score: clamp(score),
    sampleSize: pages.length,
    observed: { viewport, documentLanguage, altCoverage },
    formula: "45 viewport points + 20 document-language points + 35 points scaled by meaningful image alt coverage.",
    sourceUrls: sourceUrls(pages),
  };
}

export function buildExperienceBenchmark(domains: ExperienceDomain[]) {
  return {
    methodologyVersion: "experience-v1",
    limitations: "Bounded public crawl measurements are directional. Response time is a crawler-location proxy; purchase steps are inferred only from public controls; image readiness is not a visual-quality judgment.",
    domains: domains.map((domain): ExperienceBenchmarkDomain => ({
      domain: domain.domain,
      role: domain.role,
      observedAt: domain.fetchedAt,
      response: responseMetric(domain.pages),
      images: imageMetric(domain.pages, domain.products),
      information: informationMetric(domain.pages, domain.products),
      productAccess: productAccessMetric(domain.pages, domain.catalogProductsDiscovered),
      purchasePath: purchasePathMetric(domain.pages),
      trust: trustMetric(domain.pages),
      mobileAccessibility: mobileAccessibilityMetric(domain.pages),
    })),
  };
}
