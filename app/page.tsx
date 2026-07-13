"use client";
/* eslint-disable @next/next/no-img-element -- remote competitor images are evidence URLs with unknown hosts */

import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { postJson } from "./lib/json-response";
import { comparablePriceDelta, isDefensibleProductMatch } from "./lib/report-presentation";

type ClaimType = "Observed" | "Inferred" | "Estimated" | "Recommended";
type Locale = "en" | "ar";

type LiveAnalysis = {
  ok: true;
  live: true;
  domain: string;
  sourceUrl: string;
  fetchedAt: string;
  title: string;
  description: string;
  language: string;
  region: string;
  headings: string[];
  prices: string[];
  socialLinks: string[];
  internalLinks: string[];
  wordCount: number;
  truncated: boolean;
};

type BriefClaim = {
  id: string;
  text: string;
  sourceUrl: string;
  observedAt: string;
  claimType: ClaimType;
  confidence: "High" | "Medium" | "Low";
};
type MarketSignal = {
  label: string;
  text: string;
  implication: string;
  claimIds: string[];
};
type MarketBrief = {
  ok: true;
  headline: string;
  headlineClaimIds: string[];
  summary: string;
  summaryClaimIds: string[];
  signals: MarketSignal[];
  nextChecks: string[];
  claims: BriefClaim[];
  model: string;
  generatedAt: string;
  aiGenerated: boolean;
};
type ProductView = {
  id: string;
  domain: string;
  name: string;
  description: string;
  category: string;
  jsonLdType: string;
  priceSignals: Array<{ raw: string }>;
  attributes: string[];
  ownership: string;
  extraction: string;
  confidence: "High" | "Medium";
  sourceUrl: string;
  imageUrl: string;
  observedAt: string;
  claimIds: string[];
};
type CrawlPage = LiveAnalysis & {
  url: string;
  path: string;
  contentHash: string;
  claims: BriefClaim[];
  products: ProductView[];
  productGaps: string[];
  thirdPartyProductCount: number;
};
type CrawlDomain = {
  domain: string;
  role: "primary" | "submitted-comparison" | "discovered-competitor";
  homepage: CrawlPage | null;
  pages: CrawlPage[];
  products: ProductView[];
  candidates: Array<{
    domain: string;
    reason: string;
    sourceUrl: string;
    claimIds: string[];
  }>;
  gaps: Array<{ url: string; reason: string; observedAt: string }>;
  coverage: {
    pagesRequested: number;
    pagesFetched: number;
    maxPages: number;
    robotsChecked: boolean;
  };
  productCoverage: {
    scannedPages: number;
    catalogProductsDiscovered: number;
    thirdPartyReferenced: number;
  };
  fetchedAt: string;
  discovery?: {
    verificationScore: number;
    confidence: "High" | "Medium" | "Low";
    overlapTerms: string[];
  };
};
type JsonBlock = { type: string; id: string } & Record<string, unknown>;
type JsonReportDocument = {
  version: "1";
  generatedAt: string;
  blocks: JsonBlock[];
};
type CrawlPayload = {
  ok: true;
  live: true;
  primaryDomain: string;
  results: CrawlDomain[];
  document: JsonReportDocument;
  discovery: {
    available: boolean;
    category: string;
    region: string;
    queries: string[];
    gap?: string;
  };
  crawl: {
    maxPagesPerDomain: number;
    robotsAware: boolean;
    generatedAt: string;
  };
};
type CrawlFailure = {
  ok: false;
  live: false;
  error: string;
  results?: CrawlDomain[];
  document?: JsonReportDocument;
};

function getCompanyName(domain: string) {
  const clean = domain
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(".")[0];
  if (!clean) return "your company";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function Confidence({ value, locale = "en" }: { value: string; locale?: Locale }) {
  const label = locale === "ar" ? { High: "ثقة عالية", Medium: "ثقة متوسطة", Low: "ثقة منخفضة" }[value] || value : `${value} confidence`;
  return (
    <span className={`confidence confidence-${value.toLowerCase()}`}>
      <span />
      {label}
    </span>
  );
}

function jsonText(block: JsonBlock, key: string, fallback = "") {
  return typeof block[key] === "string" ? (block[key] as string) : fallback;
}

function jsonNumber(block: JsonBlock, key: string) {
  return typeof block[key] === "number" ? (block[key] as number) : 0;
}

function jsonList(block: JsonBlock, key: string) {
  return Array.isArray(block[key]) ? (block[key] as unknown[]) : [];
}

function object(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function product(value: unknown) {
  const item = object(value);
  return {
    item,
    name: String(item.name || "Observed product"),
    domain: String(item.domain || ""),
    description: String(item.description || ""),
    category: String(item.category || "Uncategorized"),
    sourceUrl: String(item.sourceUrl || ""),
    imageUrl: String(item.imageUrl || ""),
    extraction: String(item.extraction || "page-signal"),
    confidence: String(item.confidence || "Medium"),
    prices: Array.isArray(item.priceSignals) ? item.priceSignals.map((signal) => String(object(signal).raw || "")).filter(Boolean) : [],
    attributes: Array.isArray(item.attributes) ? item.attributes.map(String) : [],
  };
}

type BattleView = {
  primary: ReturnType<typeof product>;
  match: Record<string, unknown>;
  rival: ReturnType<typeof product>;
  decision: Record<string, unknown>;
};

function productBattles(block: JsonBlock | undefined) {
  if (!block) return [] as BattleView[];
  return jsonList(block, "rows")
    .flatMap((row) => {
      const rowItem = object(row);
      const primary = product(rowItem.primary);
      return (Array.isArray(rowItem.matches) ? rowItem.matches : [])
        .map(object)
        .filter((match) => match.product && isDefensibleProductMatch(match.score, match.confidence))
        .map((match) => ({
          primary,
          match,
          rival: product(match.product),
          decision: object(match.decision),
        }));
    })
    .sort((left, right) => Number(right.match.score || 0) - Number(left.match.score || 0));
}

function PricePicture({ battle, locale }: { battle: BattleView; locale: Locale }) {
  const ar = locale === "ar";
  const yourRaw = battle.primary.prices[0] || "";
  const rivalRaw = battle.rival.prices[0] || "";
  const comparison = comparablePriceDelta(yourRaw, rivalRaw);
  if (!comparison)
    return (
      <div className="price-fallback">
        <div>
          <span>{ar ? "سعرك المعلن" : "YOUR PUBLIC PRICE"}</span>
          <strong dir="auto">{yourRaw || (ar ? "غير متاح" : "Not observed")}</strong>
        </div>
        <div>
          <span>{ar ? "سعر المنافس" : "RIVAL PUBLIC PRICE"}</span>
          <strong dir="auto">{rivalRaw || (ar ? "غير متاح" : "Not observed")}</strong>
        </div>
      </div>
    );
  const maximum = Math.max(comparison.primary.amount, comparison.rival.amount) * 1.15 || 1;
  const yourPosition = Math.max(6, Math.min(94, (comparison.primary.amount / maximum) * 100));
  const rivalPosition = Math.max(6, Math.min(94, (comparison.rival.amount / maximum) * 100));
  const delta = comparison.percent;
  return (
    <div className="price-picture" dir="ltr">
      <div className="price-axis">
        <span className="price-line" />
        <span className="price-dot your-dot" style={{ left: `${yourPosition}%` }}>
          <b>{yourRaw}</b>
          <small>{ar ? "أنت" : "YOU"}</small>
        </span>
        <span className="price-dot rival-dot" style={{ left: `${rivalPosition}%` }}>
          <b>{rivalRaw}</b>
          <small>{ar ? "المنافس" : "RIVAL"}</small>
        </span>
      </div>
      <p dir="auto">{comparison.equal ? (ar ? "السعران المعلنان متساويان" : "Observed prices are equal") : delta === 0 ? (ar ? "فرق السعر أقل من 1٪" : "Price difference is under 1%") : delta < 0 ? (ar ? `المنافس أرخص بنسبة ${Math.abs(delta)}٪` : `Rival is ${Math.abs(delta)}% cheaper`) : ar ? `أنت أرخص بنسبة ${delta}٪` : `You are ${delta}% cheaper`}</p>
    </div>
  );
}

function PlatformPulse({ company, locale, showEvidence = true }: { company?: Record<string, unknown>; locale: Locale; showEvidence?: boolean }) {
  const ar = locale === "ar";
  const platforms = Array.isArray(company?.platforms) ? company.platforms.map(object) : [];
  return (
    <div className="platform-pulse-wrap">
      <div className="platform-pulse">
        {["Meta", "Google", "TikTok"].map((name) => {
          const platform = platforms.find((item) => item.platform === name);
          const status = String(platform?.status || "no-verified-result");
          const active = status === "verified-active";
          const limited = status === "access-limited";
          const evidence = Array.isArray(platform?.evidenceUrls) ? platform.evidenceUrls.map(String) : [];
          const href = active && evidence.length ? evidence[0] : typeof platform?.searchUrl === "string" ? platform.searchUrl : "";
          const content = (
            <>
              <i />
              <span>{name}</span>
              <b>{active ? `${Number(platform?.activeCreativeCount || 0)}${platform?.activeCreativeCountIsLowerBound ? "+" : ""} ${ar ? "إعلان نشط" : "active"}` : limited ? (ar ? "محدود" : "limited") : ar ? "غير موثق" : "unverified"}</b>
            </>
          );
          return href ? (
            <a className={`platform-chip ${active ? "platform-active" : limited ? "platform-limited" : "platform-empty"}`} href={href} target="_blank" rel="noreferrer" key={name}>
              {content}
            </a>
          ) : (
            <span className={`platform-chip ${active ? "platform-active" : limited ? "platform-limited" : "platform-empty"}`} key={name}>
              {content}
            </span>
          );
        })}
      </div>
      {showEvidence && <AdEvidenceLinks company={company} locale={locale} />}
    </div>
  );
}

function AdEvidenceLinks({ company, locale }: { company?: Record<string, unknown>; locale: Locale }) {
  const ar = locale === "ar";
  const platforms = Array.isArray(company?.platforms) ? company.platforms.map(object) : [];
  const records = platforms.flatMap((platform) =>
    (Array.isArray(platform.evidenceUrls) ? platform.evidenceUrls : []).map(String).map((url, index) => ({
      url,
      platform: String(platform.platform),
      index,
    })),
  );
  const meta = platforms.find((platform) => platform.platform === "Meta");
  const concepts = Array.isArray(meta?.creativeConcepts) ? meta.creativeConcepts.map(object).slice(0, 3) : [];
  const comparison = object(company?.comparisonToPrimary);
  if (concepts.length || comparison.headline)
    return (
      <div className="ad-strategy-panel">
        <div className="ad-strategy-verdict">
          <span>{ar ? "الفجوة الإعلانية" : "PAID ATTENTION GAP"}</span>
          <strong dir="auto">{String(comparison.headline || (ar ? "نشاط إعلاني موثق" : "Verified active creative"))}</strong>
          <p dir="auto">{String(comparison.implication || meta?.message || "")}</p>
        </div>
        {concepts.length > 0 && (
          <div className="ad-concept-grid">
            {concepts.map((concept, index) => (
              <article className="ad-concept-card" key={String(concept.id || index)}>
                {typeof concept.mediaUrl === "string" && concept.mediaUrl && <img src={concept.mediaUrl} alt="" loading="lazy" />}
                <div>
                  <span>{ar ? `رسالة ${index + 1}` : `MESSAGE CONCEPT ${index + 1}`}</span>
                  <strong dir="auto">{String(concept.message || concept.caption || (ar ? "إعلان مرئي بدون نص عام" : "Visual creative without public copy"))}</strong>
                  <p dir="auto">{[concept.caption, concept.callToAction].map(String).filter(Boolean).join(" · ")}</p>
                  <small>
                    {Number(concept.placementCount || 1)} {ar ? "موضع" : "placement"}
                    {Number(concept.placementCount || 1) === 1 ? "" : "s"}
                    {concept.startDate ? ` · ${String(concept.startDate).slice(0, 10)}` : ""}
                  </small>
                </div>
                <SafeExternalLink href={String(concept.evidenceUrl || "")}>{ar ? "شاهد الإعلان ↗" : "View exact ad ↗"}</SafeExternalLink>
              </article>
            ))}
          </div>
        )}
        <div className="ad-attribution">
          <span>{ar ? "إسناد المعلن" : "EXACT ADVERTISER"}</span>
          <SafeExternalLink href={String(meta?.attributionUrl || meta?.searchUrl || "")}>{String(meta?.attributionLabel || (ar ? "تحقق من الصفحة" : "Verify Page attribution"))} ↗</SafeExternalLink>
          <em>{ar ? "مزود مؤقت غير رسمي؛ الدليل مرتبط بسجل Meta العام." : "Temporary unofficial provider; evidence links to the public Meta record."}</em>
        </div>
      </div>
    );
  if (!records.length) return null;
  return (
    <div className="dossier-ad-evidence">
      {records.map((record) => (
        <a href={record.url} target="_blank" rel="noreferrer" key={`${record.platform}-${record.url}`}>
          {ar ? `سجل ${record.platform} ${record.index + 1} ↗` : `${record.platform} direct record ${record.index + 1} ↗`}
        </a>
      ))}
    </div>
  );
}

function SafeExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!href || href === "#") return <span className="missing-evidence">{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function PositioningComparison({ competitor, locale }: { competitor: JsonBlock; locale: Locale }) {
  const ar = locale === "ar";
  const shared = jsonList(competitor, "sharedOfferings").map(String).filter(Boolean).slice(0, 5);
  return (
    <article className="positioning-comparison">
      <div>
        <span>{ar ? "السوق المشترك" : "SHARED MARKET"}</span>
        <strong dir="auto">{jsonText(competitor, "marketCategory", ar ? "فئة السوق المستنتجة" : "Inferred market category")}</strong>
      </div>
      <div>
        <span>{ar ? "ما يتقاطع" : "OFFERING OVERLAP"}</span>
        <strong dir="auto">{shared.length ? shared.join(" · ") : ar ? "تشابه على مستوى الشركة؛ لا توجد مطابقة منتج موثقة بعد" : "Company-level overlap; no defensible product pair yet"}</strong>
      </div>
      <div>
        <span>{ar ? "ما يجب التحقق منه" : "NEXT PROOF TO COLLECT"}</span>
        <strong>{ar ? "قارن التشكيلة والأسعار والرسائل على الصفحات العامة." : "Compare its public assortment, pricing, and messaging before changing your offer."}</strong>
      </div>
    </article>
  );
}

function GuidedReportRenderer({ document: doc, locale, marketBrief, briefLoading }: { document: JsonReportDocument; locale: Locale; marketBrief: MarketBrief | null; briefLoading: boolean }) {
  const ar = locale === "ar";
  const summary = doc.blocks.find((block) => block.type === "summary");
  const profile = doc.blocks.find((block) => block.type === "market-profile");
  const competitors = doc.blocks.filter((block) => block.type === "competitor").sort((left, right) => jsonNumber(right, "verificationScore") - jsonNumber(left, "verificationScore"));
  const comparison = doc.blocks.find((block) => block.type === "product-comparison");
  const allBattles = productBattles(comparison);
  const competitorDomains = new Set(competitors.map((competitor) => jsonText(competitor, "domain")));
  const battles = allBattles.filter((battle) => competitorDomains.has(String(battle.match.domain)));
  const ads = doc.blocks.find((block) => block.type === "ad-intelligence");
  const adCompanies = jsonList(ads || { type: "", id: "" }, "companies").map(object);
  const adLimitation = jsonText(ads || { type: "", id: "" }, "limitation");
  const gaps = doc.blocks.filter((block) => block.type === "gap");
  const battlesFor = (domain: string) => battles.filter((battle) => String(battle.match.domain) === domain);
  const adFor = (domain: string) => adCompanies.find((company) => String(company.domain) === domain);
  const strongest = competitors[0];
  const strongestDomain = strongest ? jsonText(strongest, "domain") : "";
  const [openDossiers, setOpenDossiers] = useState<Set<string>>(() => {
    const hashId = typeof window !== "undefined" && window.location.hash.startsWith("#dossier-") ? window.location.hash.slice(1) : "";
    const dossierId = hashId || (strongestDomain ? `dossier-${strongestDomain}` : "");
    return new Set(dossierId ? [dossierId] : []);
  });

  function setDossierOpen(dossierId: string, open: boolean) {
    setOpenDossiers((current) => {
      if (current.has(dossierId) === open) return current;
      const next = new Set(current);
      if (open) next.add(dossierId);
      else next.delete(dossierId);
      return next;
    });
  }

  const headline = marketBrief?.headline || jsonText(summary || { type: "", id: "" }, "title", ar ? "جارٍ بناء صورة السوق" : "Building your market picture");
  const summaryText = marketBrief?.summary || jsonText(summary || { type: "", id: "" }, "body");
  return (
    <section
      className="guided-report"
      aria-label={ar ? "تقرير منافسين موجه" : "Guided competitor report"}
      onClick={(event) => {
        const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#dossier-"]');
        if (!anchor) return;
        const dossierId = anchor.hash.slice(1);
        setDossierOpen(dossierId, true);
        window.setTimeout(() => globalThis.document.getElementById(dossierId)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      }}
    >
      <section className="verdict-band" id="market-verdict">
        <div className="verdict-copy">
          <span className="chapter-kicker">01 · {ar ? "الخلاصة" : "THE VERDICT"}</span>
          <h3 dir="auto">{headline}</h3>
          <p dir="auto">{briefLoading && !marketBrief ? (ar ? "نربط الأدلة في خلاصة تساعدك على القرار…" : "Connecting the evidence into a decision-ready verdict…") : summaryText}</p>
          <div className="scope-line">
            <span>{jsonText(profile || { type: "", id: "" }, "category", ar ? "السوق المستنتج" : "Inferred market")}</span>
            <i /> <span>{jsonText(profile || { type: "", id: "" }, "region", ar ? "المنطقة المستنتجة" : "Inferred region")}</span>
          </div>
        </div>
        <div className="verdict-numbers">
          <div>
            <strong>{competitors.length}</strong>
            <span>{ar ? "منافسون موثقون" : "verified rivals"}</span>
          </div>
          <div>
            <strong>{battles.length}</strong>
            <span>{ar ? "مواجهات منتجات" : "product battles"}</span>
          </div>
        </div>
        {strongest && (
          <a className="verdict-focus" href={`#dossier-${jsonText(strongest, "domain")}`}>
            <span>{ar ? "ابدأ بأقوى تهديد" : "START WITH THE STRONGEST THREAT"}</span>
            <strong>{jsonText(strongest, "companyName") || jsonText(strongest, "domain")}</strong>
            <b>
              {jsonNumber(strongest, "verificationScore")}/100 {ar ? "←" : "→"}
            </b>
          </a>
        )}
      </section>

      <div className="report-story-layout">
        <nav className="story-rail" aria-label={ar ? "فصول التقرير" : "Report chapters"}>
          <a href="#market-verdict">
            <b>01</b>
            <span>{ar ? "الخلاصة" : "Verdict"}</span>
          </a>
          <a href="#threat-board">
            <b>02</b>
            <span>{ar ? "خريطة المنافسين" : "Threat map"}</span>
          </a>
          <a href="#rival-dossiers">
            <b>03</b>
            <span>{ar ? "ملفات المنافسين" : "Rival dossiers"}</span>
          </a>
          <a href="#evidence-appendix">
            <b>04</b>
            <span>{ar ? "الأدلة" : "Evidence"}</span>
          </a>
        </nav>
        <div className="story-content">
          <section className="story-chapter" id="threat-board">
            <div className="chapter-heading">
              <div>
                <span className="chapter-kicker">02 · {ar ? "خريطة المنافسين" : "THREAT MAP"}</span>
                <h3>{ar ? "من يستحق انتباهك أولاً؟" : "Who deserves your attention first?"}</h3>
              </div>
              <p>{ar ? "الترتيب مبني على تحقق المنتج والمنطقة، وليس على شهرة العلامة." : "Ranked by first-party category evidence, offering overlap, and region—not brand popularity."}</p>
            </div>
            {competitors.length ? (
              <div className="threat-board">
                {competitors.map((competitor, index) => {
                  const domain = jsonText(competitor, "domain");
                  const score = jsonNumber(competitor, "verificationScore");
                  const rivalBattles = battlesFor(domain);
                  return (
                    <div className="threat-row" key={competitor.id}>
                      <span className="threat-rank">{String(index + 1).padStart(2, "0")}</span>
                      <a className="threat-name" href={`#dossier-${domain}`}>
                        <strong>{jsonText(competitor, "companyName") || domain}</strong>
                        <span>{rivalBattles.length ? (ar ? `${rivalBattles.length} مواجهة منتجات موثوقة` : `${rivalBattles.length} defensible product battle${rivalBattles.length === 1 ? "" : "s"}`) : ar ? "لا توجد مواجهة منتجات موثوقة بعد" : "Verified company-level overlap; product pair pending"}</span>
                      </a>
                      <div className="threat-score">
                        <div>
                          <i style={{ width: `${score}%` }} />
                        </div>
                        <span>{score}/100</span>
                      </div>
                      <PlatformPulse company={adFor(domain)} locale={locale} showEvidence={false} />
                      <a className="threat-arrow" href={`#dossier-${domain}`} aria-label={ar ? `افتح ملف ${domain}` : `Open ${domain} dossier`}>
                        {ar ? "←" : "→"}
                      </a>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty-story">
                <strong>{ar ? "لا يوجد منافس اجتاز التحقق بعد" : "No rival passed verification yet"}</strong>
                <p>{summaryText}</p>
              </div>
            )}
          </section>

          <section className="story-chapter" id="rival-dossiers">
            <div className="chapter-heading">
              <div>
                <span className="chapter-kicker">03 · {ar ? "ملفات المنافسين" : "RIVAL DOSSIERS"}</span>
                <h3>{ar ? "الدليل، الفرق، والخطوة التالية" : "Proof, difference, and next move"}</h3>
              </div>
              <p>{ar ? "افتح أي منافس لرؤية القصة كاملة دون تشتيت." : "Open a rival to follow the full story without the noise."}</p>
            </div>
            <div className="dossier-list">
              {competitors.map((competitor, index) => {
                const domain = jsonText(competitor, "domain");
                const rivalBattles = battlesFor(domain);
                const companyAds = adFor(domain);
                const firstAction = String(rivalBattles[0]?.decision.recommendedMove || companyAds?.recommendedAction || (ar ? "قارن التشكيلة والأسعار والرسائل العامة قبل تغيير عرضك." : "Compare their public assortment, pricing, and messaging before changing your offer."));
                return (
                  <details className="rival-dossier" id={`dossier-${domain}`} key={competitor.id} open={openDossiers.has(`dossier-${domain}`)} onToggle={(event) => setDossierOpen(`dossier-${domain}`, event.currentTarget.open)}>
                    <summary>
                      <span className="dossier-rank">{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{jsonText(competitor, "companyName") || domain}</strong>
                        <span>{jsonText(competitor, "matchedPrimaryProductName") && jsonText(competitor, "matchedProductName") ? `${jsonText(competitor, "matchedPrimaryProductName")} ↔ ${jsonText(competitor, "matchedProductName")}` : jsonText(competitor, "marketCategory", ar ? "منافس موثق على مستوى الشركة" : "Verified company-level competitor")}</span>
                      </div>
                      <div className="dossier-score">
                        <b>{jsonNumber(competitor, "verificationScore")}</b>
                        <span>{ar ? "درجة التحقق" : "verification"}</span>
                      </div>
                      <i className="dossier-toggle" />
                    </summary>
                    <div className="dossier-body">
                      <div className="proof-strip">
                        <div>
                          <span>{ar ? "لماذا هو منافس حقيقي" : "WHY THIS IS A REAL RIVAL"}</span>
                          <p dir="auto">{jsonText(competitor, "reason")}</p>
                        </div>
                        <SafeExternalLink href={jsonText(competitor, "matchedProductUrl")}>{ar ? (jsonText(competitor, "matchedPrimaryProductName") ? "افتح منتج الإثبات ↗" : "افتح دليل الشركة ↗") : jsonText(competitor, "matchedPrimaryProductName") ? "Open proving product ↗" : "Open company evidence ↗"}</SafeExternalLink>
                      </div>
                      <div className="dossier-battles">
                        {rivalBattles.length === 0 && <PositioningComparison competitor={competitor} locale={locale} />}
                        {rivalBattles.map((battle, battleIndex) => (
                          <article className="guided-battle" key={`${domain}-${battleIndex}`}>
                            <div className="battle-product-head">
                              <div className="battle-product your-product">
                                {battle.primary.imageUrl && <img src={battle.primary.imageUrl} alt="" loading="lazy" />}
                                <span>{ar ? "منتجك" : "YOUR PRODUCT"}</span>
                                <strong dir="auto">{battle.primary.name}</strong>
                              </div>
                              <div className="battle-connector">
                                <span>{Math.round(Number(battle.match.score || 0) * 100)}%</span>
                                <i />
                              </div>
                              <div className="battle-product rival-product">
                                {battle.rival.imageUrl && <img src={battle.rival.imageUrl} alt="" loading="lazy" />}
                                <span>{ar ? "منتج المنافس" : "RIVAL PRODUCT"}</span>
                                <strong dir="auto">{battle.rival.name}</strong>
                              </div>
                            </div>
                            <PricePicture battle={battle} locale={locale} />
                            <div className="decision-path">
                              <div>
                                <span>{ar ? "ما نراه" : "WHAT WE SEE"}</span>
                                <p>{String(battle.decision.priceVerdict || (ar ? "لم نرصد سعرين عامين قابلين للمقارنة بعد." : "Two comparable public prices were not observed yet."))}</p>
                              </div>
                              <div>
                                <span>{ar ? "لماذا قد يفوز" : "WHY THEY MAY WIN"}</span>
                                <p>{String(battle.decision.whyTheyMayWin || (ar ? "لا يوجد دليل كافٍ لادعاء أفضلية لهذا المنتج بعد." : "There is not enough evidence to claim an advantage for this product yet."))}</p>
                              </div>
                              <div className="decision-action">
                                <span>{ar ? "قرارك التالي" : "YOUR NEXT DECISION"}</span>
                                <p>{String(battle.decision.recommendedMove || (ar ? "تحقق من العرضين قبل تغيير السعر أو الرسالة." : "Verify both offers before changing price or messaging."))}</p>
                              </div>
                            </div>
                            <footer>
                              <SafeExternalLink href={battle.primary.sourceUrl}>{ar ? "مصدر منتجك ↗" : "Your source ↗"}</SafeExternalLink>
                              <SafeExternalLink href={battle.rival.sourceUrl}>{ar ? "مصدر المنافس ↗" : "Rival source ↗"}</SafeExternalLink>
                            </footer>
                          </article>
                        ))}
                      </div>
                      <div className="dossier-ad-row">
                        <div>
                          <span>{ar ? "نبض الإعلانات" : "AD PULSE"}</span>
                          <PlatformPulse company={companyAds} locale={locale} />
                        </div>
                        <p dir="auto">{String(companyAds?.summary || (ar ? "لم يتم توثيق إعلان نشط تلقائياً؛ افتح المكتبات للتحقق يدوياً." : "No active creative was automatically verified; open the libraries to inspect manually."))}</p>
                      </div>
                      <div className="dossier-next">
                        <span>{ar ? "خطوتك الأولى" : "FIRST MOVE"}</span>
                        <strong dir="auto">{firstAction}</strong>
                      </div>
                      <div className="dossier-sources">
                        <SafeExternalLink href={jsonText(competitor, "websiteSourceUrl")}>{domain} ↗</SafeExternalLink>
                        <SafeExternalLink href={jsonText(competitor, "discoverySourceUrl")}>{ar ? "دليل الاكتشاف ↗" : "Discovery evidence ↗"}</SafeExternalLink>
                        <Confidence value={jsonText(competitor, "confidence", "Low")} locale={locale} />
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>

          <details className="evidence-appendix" id="evidence-appendix">
            <summary>
              <div>
                <span className="chapter-kicker">04 · {ar ? "الأدلة والتغطية" : "EVIDENCE & COVERAGE"}</span>
                <strong>{ar ? "اعرض الفجوات والمنهج" : "Show gaps and methodology"}</strong>
              </div>
              <span>
                {gaps.length} {ar ? "ملاحظات" : "notes"}
              </span>
            </summary>
            <div>
              {gaps.map((gap) => (
                <article key={gap.id}>
                  <strong>{jsonText(gap, "domain")}</strong>
                  <p dir="auto">{jsonText(gap, "reason")}</p>
                  {jsonText(gap, "url") && (
                    <a href={jsonText(gap, "url")} target="_blank" rel="noreferrer">
                      {ar ? "افحص المصدر ↗" : "Inspect source ↗"}
                    </a>
                  )}
                </article>
              ))}
              <p className="appendix-note">{adLimitation || (ar ? "تعرض الرسومات فقط قيماً عامة قابلة للتحليل. لا نستنتج إنفاقاً إعلانياً أو نشاطاً غير موثق." : "Charts render only parseable public values. We never infer ad spend or unverified activity.")}</p>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [locale, setLocale] = useState<Locale>("en");
  const [domain, setDomain] = useState("");
  const [reportDomain, setReportDomain] = useState<string | null>(null);
  const [liveAnalysis, setLiveAnalysis] = useState<LiveAnalysis | null>(null);
  const [crawlDocument, setCrawlDocument] = useState<JsonReportDocument | null>(null);
  const [marketBrief, setMarketBrief] = useState<MarketBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [toast, setToast] = useState("");

  const companyName = useMemo(() => getCompanyName(reportDomain ?? domain), [domain, reportDomain]);
  const ar = locale === "ar";

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = ar ? "rtl" : "ltr";
  }, [ar, locale]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanDomain = domain.trim();
    const requestedDomains = [cleanDomain];
    setIsAnalyzing(true);
    setAnalysisError("");
    setLiveAnalysis(null);
    setMarketBrief(null);
    setCrawlDocument(null);
    setReportDomain(null);
    try {
      const payload = await postJson<CrawlPayload | CrawlFailure>("/api/crawl", { primary: cleanDomain, domains: requestedDomains }, "The competitor scan");
      if (!payload.ok) {
        if (payload.document) setCrawlDocument(payload.document);
        setReportDomain(cleanDomain);
        setAnalysisError(("error" in payload ? payload.error : "") || "The public crawl could not be completed.");
        window.setTimeout(() => document.getElementById("report")?.scrollIntoView({ behavior: "smooth" }), 50);
        return;
      }
      const crawlResults = payload.results;
      const successful = crawlResults.flatMap((result) => (result.homepage ? [result.homepage] : []));
      const primaryHost = payload.primaryDomain;
      const primaryResult = successful.find((result) => result.domain === primaryHost);
      if (!primaryResult) throw new Error(`Primary domain ${cleanDomain} could not be crawled: ${crawlResults.find((result) => result.domain === primaryHost)?.gaps[0]?.reason || "no live result was returned"}`);
      setLiveAnalysis(primaryResult);
      setCrawlDocument(payload.document);
      setReportDomain(cleanDomain);
      setBriefLoading(true);
      try {
        const briefPayload = await postJson<MarketBrief | { ok: false; error?: string }>(
          "/api/report",
          {
            primary: primaryResult.domain,
            domains: successful.map((result) => result.domain),
          },
          "The market brief",
        );
        if (briefPayload.ok) setMarketBrief(briefPayload);
        else setAnalysisError(("error" in briefPayload ? briefPayload.error : "") || "The source scan completed, but the market brief was unavailable.");
      } catch {
        setAnalysisError("The source scan completed, but the market brief was unavailable.");
      } finally {
        setBriefLoading(false);
      }
      window.setTimeout(() => document.getElementById("report")?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "Unable to analyze this domain.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  return (
    <main className="app-root" lang={locale} dir={ar ? "rtl" : "ltr"}>
      <header className="site-header shell">
        <a className="brand" href="#top" aria-label="Market Signal home">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>Market Signal</span>
          <span className="beta-pill">BETA</span>
        </a>
        <nav className="header-nav" aria-label={ar ? "التنقل الرئيسي" : "Primary navigation"}>
          <a href="#report">{ar ? "التقرير" : "Live report"}</a>
          <a href="#method">{ar ? "منهجنا" : "Our method"}</a>
          <button className="language-switch" type="button" onClick={() => setLocale(ar ? "en" : "ar")} aria-label={ar ? "Switch to English" : "التبديل إلى العربية"}>
            <span aria-hidden="true">{ar ? "EN" : "ع"}</span>
            {ar ? "English" : "العربية"}
          </button>
          <button className="quiet-button" onClick={() => showToast(ar ? "ستتوفر الحسابات بعد أن يثبت التقرير قيمته." : "Accounts arrive after the report proves value.")}>
            {ar ? "تسجيل الدخول لاحقاً" : "Sign in later"} <span>↗</span>
          </button>
        </nav>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="pulse-dot" /> {ar ? "معلومات تنافسية لمن يريد الإجابة الآن" : "Competitive intelligence for the impatient"}
          </div>
          <h1>
            {ar ? (
              <>
                اعرف إلى أين يتحرك سوقك <em>قبل أن يسبقك.</em>
              </>
            ) : (
              <>
                Know where your market is moving <em>before it moves you.</em>
              </>
            )}
          </h1>
          <p className="hero-lede">{ar ? "أدخل نطاق شركتك. سنجد منافسيك ونقارن المنتجات والأسعار والإعلانات العامة ونوضح لك ما الذي يجب فعله." : "Enter a domain. Get the competitive picture behind the noise: who is gaining ground, what they sell, what they charge, and how they show up in public."}</p>
          <form className="domain-form" onSubmit={analyze}>
            <label htmlFor="domain">{ar ? "نطاق شركتك أو رابط الموقع" : "Your company domain or URL"}</label>
            <div className="input-row">
              <div className="domain-input">
                <input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder={ar ? "example.com أو الصق الرابط الكامل" : "yourcompany.com or paste the full URL"} dir="ltr" />
              </div>
              <button className="primary-button" type="submit" disabled={isAnalyzing}>
                {isAnalyzing ? (ar ? "جارٍ البحث والتحقق…" : "Finding and verifying rivals…") : ar ? "ابحث عن منافسيّ" : "Find my competitors"} <span>{isAnalyzing ? "·" : ar ? "←" : "→"}</span>
              </button>
            </div>
            <div className="form-note">
              <span className="lock">◇</span> {ar ? "تقرير مجاني · دون حساب · بيانات عامة فقط" : "One free report · no account required · public signals only"}
            </div>
            {analysisError && (
              <div className="analysis-error" role="alert">
                {analysisError}
              </div>
            )}
          </form>
          <div className="trusted-row">
            <span>{ar ? "مصمم للفرق التي تحتاج سياقاً تنافسياً عميقاً" : "Built for teams who need an unfair amount of context"}</span>
            <span className="trusted-line" />
            <span>{ar ? "الشركات الناشئة" : "STARTUPS"}</span>
            <span>{ar ? "الوكالات" : "AGENCIES"}</span>
            <span>{ar ? "التجارة الإلكترونية" : "ECOMMERCE"}</span>
          </div>
        </div>
        <div className="hero-preview method-preview" aria-label="How Market Signal collects evidence">
          <div className="preview-top">
            <span className="window-dot coral" />
            <span className="window-dot amber" />
            <span className="window-dot green" />
            <span className="preview-label">{ar ? "السوق / منهج الأدلة" : "MARKET / EVIDENCE METHOD"}</span>
            <span className="preview-time">{ar ? "بيانات عامة فقط" : "public only"}</span>
          </div>
          <div className="preview-body">
            <div className="preview-kicker">{ar ? "لا بيانات سوق مخترعة" : "NO INVENTED MARKET DATA"}</div>
            <div className="preview-title">
              {ar ? (
                <>
                  تقرير مبني على <strong>ما يظهره الويب فعلاً.</strong>
                </>
              ) : (
                <>
                  A report built from <strong>what the web actually shows.</strong>
                </>
              )}
            </div>
            <div className="method-preview-list">
              <div>
                <b>01</b>
                <span>{ar ? "نجمع الصفحات العامة والروابط والأسعار والتوقيتات." : "Collect public pages, links, pricing patterns, and timestamps."}</span>
              </div>
              <div>
                <b>02</b>
                <span>{ar ? "نربط الأدلة بين النطاقات واللقطات الزمنية." : "Connect claims across domains and historical snapshots."}</span>
              </div>
              <div>
                <b>03</b>
                <span>{ar ? "نشرح فقط ما تدعمه الأدلة." : "Explain only what the evidence can support."}</span>
              </div>
            </div>
            <div className="preview-foot">
              <span>
                <b>{ar ? "مباشر" : "LIVE"}</b> {ar ? "بعد إرسال النطاق" : "after you submit a domain"}
              </span>
              <span>
                <b>{ar ? "عام" : "PUBLIC"}</b> {ar ? "مسار المصادر" : "source trail"}
              </span>
              <span>
                <b>{ar ? "دون" : "NO"}</b> {ar ? "نتائج مؤقتة" : "fixture results"}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className={`report-section shell ${reportDomain ? "report-visible" : ""}`} id="report" aria-live="polite">
        <div className="report-header">
          <div>
            <div className="eyebrow">
              <span className="pulse-dot" /> {ar ? "تقرير المشهد التنافسي" : "Competitive landscape report"}
            </div>
            <h2>{liveAnalysis ? (ar ? `${companyName} في مواجهة السوق.` : `${companyName} against the market.`) : ar ? "تقرير يبدأ برابط واحد." : "A report that starts with one URL."}</h2>
            <p>{liveAnalysis ? (ar ? "بحثنا في السوق المتوقع، وتحققنا من مواقع المنافسين، وقارنّا المنتجات العامة المنسوبة إليهم." : "We searched the inferred market, verified candidate websites, and compared the public products we could attribute.") : ar ? "أرسل نطاقاً واحداً وسنجد المنافسين ونتحقق منهم نيابةً عنك." : "Submit one domain. Market Signal finds and verifies the competitors for you."}</p>
          </div>
        </div>

        {crawlDocument ? (
          <GuidedReportRenderer document={crawlDocument} locale={locale} marketBrief={marketBrief} briefLoading={briefLoading} />
        ) : (
          <div className="report-empty-state">
            <span>01 → 02 → 03 → 04</span>
            <strong>{ar ? "أرسل نطاقك لبدء التحقيق" : "Submit your domain to start the investigation"}</strong>
            <p>{ar ? "سنوجهك من الخلاصة إلى المنافسين ثم مواجهات المنتجات وخطواتك التالية." : "We will guide you from verdict to rivals, product battles, and your next move."}</p>
          </div>
        )}
      </section>

      <section className="method-section shell">
        <div className="method-copy">
          <div className="eyebrow">{ar ? "الإشارة، لا الضوضاء" : "The signal, not the spectacle"}</div>
          <h2>
            {ar ? (
              <>
                شاهد ما نعرفه.
                <br />
                <em>وشاهد كيف عرفناه.</em>
              </>
            ) : (
              <>
                See what we know.
                <br />
                <em>See how we know it.</em>
              </>
            )}
          </h2>
          <p>{ar ? "يفصل Market Signal بين الرصد العام واستنتاجات الذكاء الاصطناعي والتقديرات والتوصيات، ليحوّل الإجابة السريعة إلى قرار مفيد." : "Market Signal separates public observations from AI inferences, estimates, and recommendations. That is how a fast answer becomes a useful one."}</p>
        </div>
        <div className="method-steps">
          <div>
            <span>01</span>
            <strong>{ar ? "نجمع" : "Collect"}</strong>
            <p>{ar ? "المواقع العامة وصفحات الأسعار ونتائج البحث ومكتبات الإعلانات." : "Public websites, pricing pages, search landscapes, and ad libraries."}</p>
          </div>
          <div>
            <span>02</span>
            <strong>{ar ? "نربط" : "Connect"}</strong>
            <p>{ar ? "نوحد الأدلة بين المناطق والقنوات وأنماط المنافسين." : "Normalize evidence across regions, channels, and competitor patterns."}</p>
          </div>
          <div>
            <span>03</span>
            <strong>{ar ? "نشرح" : "Explain"}</strong>
            <p>{ar ? "نحوّل الإشارة إلى قرار يمكنك تنفيذه هذا الأسبوع." : "Turn the signal into a decision your team can act on this week."}</p>
          </div>
        </div>
      </section>

      <footer className="site-footer shell">
        <a className="brand" href="#top">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>Market Signal</span>
        </a>
        <span>{ar ? "معلومات عامة تتحول إلى قرار مفيد." : "Public intelligence, made useful."}</span>
        <span>© 2026 Market Signal</span>
      </footer>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}
