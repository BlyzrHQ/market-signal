"use client";
/* eslint-disable @next/next/no-img-element -- remote competitor images are evidence URLs with unknown hosts */

import { FormEvent, useEffect, useMemo, useState } from "react";

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

type BriefClaim = { id: string; text: string; sourceUrl: string; observedAt: string; claimType: ClaimType; confidence: "High" | "Medium" | "Low" };
type MarketSignal = { label: string; text: string; implication: string; claimIds: string[] };
type MarketBrief = { ok: true; headline: string; headlineClaimIds: string[]; summary: string; summaryClaimIds: string[]; signals: MarketSignal[]; nextChecks: string[]; claims: BriefClaim[]; model: string; generatedAt: string; aiGenerated: boolean };
type ProductView = { id: string; domain: string; name: string; description: string; category: string; jsonLdType: string; priceSignals: Array<{ raw: string }>; attributes: string[]; ownership: string; extraction: string; confidence: "High" | "Medium"; sourceUrl: string; imageUrl: string; observedAt: string; claimIds: string[] };
type CrawlPage = LiveAnalysis & { url: string; path: string; contentHash: string; claims: BriefClaim[]; products: ProductView[]; productGaps: string[]; thirdPartyProductCount: number };
type CrawlDomain = { domain: string; role: "primary" | "submitted-comparison" | "discovered-competitor"; homepage: CrawlPage | null; pages: CrawlPage[]; products: ProductView[]; candidates: Array<{ domain: string; reason: string; sourceUrl: string; claimIds: string[] }>; gaps: Array<{ url: string; reason: string; observedAt: string }>; coverage: { pagesRequested: number; pagesFetched: number; maxPages: number; robotsChecked: boolean }; productCoverage: { scannedPages: number; catalogProductsDiscovered: number; thirdPartyReferenced: number }; fetchedAt: string; discovery?: { verificationScore: number; confidence: "High" | "Medium" | "Low"; overlapTerms: string[] } };
type JsonBlock = { type: string; id: string } & Record<string, unknown>;
type JsonReportDocument = { version: "1"; generatedAt: string; blocks: JsonBlock[] };
type CrawlPayload = { ok: true; live: true; primaryDomain: string; results: CrawlDomain[]; document: JsonReportDocument; discovery: { available: boolean; category: string; region: string; queries: string[]; gap?: string }; crawl: { maxPagesPerDomain: number; robotsAware: boolean; generatedAt: string } };
type CrawlFailure = { ok: false; live: false; error: string; results?: CrawlDomain[]; document?: JsonReportDocument };

function getCompanyName(domain: string) {
  const clean = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split(".")[0];
  if (!clean) return "your company";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function Confidence({ value, locale = "en" }: { value: string; locale?: Locale }) {
  const label = locale === "ar" ? ({ High: "ثقة عالية", Medium: "ثقة متوسطة", Low: "ثقة منخفضة" }[value] || value) : `${value} confidence`;
  return <span className={`confidence confidence-${value.toLowerCase()}`}><span />{label}</span>;
}

function jsonText(block: JsonBlock, key: string, fallback = "") {
  return typeof block[key] === "string" ? block[key] as string : fallback;
}

function jsonNumber(block: JsonBlock, key: string) {
  return typeof block[key] === "number" ? block[key] as number : 0;
}

function jsonList(block: JsonBlock, key: string) {
  return Array.isArray(block[key]) ? block[key] as unknown[] : [];
}

function object(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function product(value: unknown) {
  const item = object(value);
  return { item, name: String(item.name || "Observed product"), domain: String(item.domain || ""), description: String(item.description || ""), category: String(item.category || "Uncategorized"), sourceUrl: String(item.sourceUrl || "#"), imageUrl: String(item.imageUrl || ""), extraction: String(item.extraction || "page-signal"), confidence: String(item.confidence || "Medium"), prices: Array.isArray(item.priceSignals) ? item.priceSignals.map((signal) => String(object(signal).raw || "")).filter(Boolean) : [], attributes: Array.isArray(item.attributes) ? item.attributes.map(String) : [] };
}

function ProductComparisonBlock({ block, locale }: { block: JsonBlock; locale: Locale }) {
  const decisions = jsonList(block, "rows").flatMap((row) => {
    const rowItem = object(row);
    const matches = Array.isArray(rowItem.matches) ? rowItem.matches.map(object).filter((match) => match.product) : [];
    const best = [...matches].sort((left, right) => Number(right.score || 0) - Number(left.score || 0))[0];
    return best ? [{ primary: product(rowItem.primary), match: best, rival: product(best.product), decision: object(best.decision) }] : [];
  }).slice(0, 10);
  const ar = locale === "ar";
  return <article className="json-block product-comparison-block" key={block.id}><div className="json-block-heading"><div><span className="json-block-type">{ar ? "قرارات المنتجات" : "PRODUCT DECISIONS"}</span><h4>{ar ? "أين يمكن لمنتج منافس أن يتفوق على منتجك؟" : "Where a competing product can beat yours"}</h4></div><span className="decision-count">{ar ? `${decisions.length} مقارنات مدعومة بالأدلة` : `${decisions.length} evidence-backed match${decisions.length === 1 ? "" : "es"}`}</span></div><p className="product-coverage-note">{ar ? "نعرض فقط أقوى المقارنات التي تدعمها الأدلة، مع رابط إلى صفحتي المنتج." : "Only the strongest defensible product matches are shown. Every row links back to both public product pages."}</p>{decisions.length ? <div className="product-matrix">{decisions.map(({ primary, match, rival, decision }, rowIndex) => <section className="product-battle" key={`${block.id}-battle-${rowIndex}`}><header><div className="product-identity">{primary.imageUrl && <img src={primary.imageUrl} alt="" loading="lazy" />}<div><span>{ar ? "منتجك" : "YOUR PRODUCT"}</span><strong dir="auto">{primary.name}</strong></div></div><div className="battle-vs">{ar ? "مقابل" : "VS"}</div><div className="product-identity">{rival.imageUrl && <img src={rival.imageUrl} alt="" loading="lazy" />}<div><span>{String(match.domain)}</span><strong dir="auto">{rival.name}</strong></div></div></header><div className="battle-facts"><div><span>{ar ? "سعرك المعلن" : "Your public price"}</span><strong dir="auto">{primary.prices[0] || (ar ? "غير متاح" : "Not observed")}</strong></div><div><span>{ar ? "سعر المنافس المعلن" : "Rival public price"}</span><strong dir="auto">{rival.prices[0] || (ar ? "غير متاح" : "Not observed")}</strong></div><div><span>{ar ? "ثقة المقارنة" : "Comparison confidence"}</span><strong>{Math.round(Number(match.score || 0) * 100)}%</strong></div></div><div className="battle-verdict"><div><span>{ar ? "حكم السعر والعرض" : "PRICE / OFFER VERDICT"}</span><strong>{String(decision.priceVerdict || (ar ? "لا يمكن مقارنة الأسعار العامة حتى الآن." : "Public prices are not comparable yet."))}</strong></div><div><span>{ar ? "لماذا قد يفوز المنافس؟" : "WHY THEY MAY WIN"}</span><p>{String(decision.whyTheyMayWin || (ar ? "هذا هو أقرب بديل ظاهر في البيانات العامة." : "The rival is the closest observable product alternative."))}</p></div><div className="battle-action"><span>{ar ? "ماذا تفعل؟" : "WHAT TO DO"}</span><p>{String(decision.recommendedMove || (ar ? "تحقق من حجم العبوة والسعر النهائي قبل تغيير عرضك." : "Validate pack size and landed price before changing your offer."))}</p></div></div><footer><a href={primary.sourceUrl} target="_blank" rel="noreferrer">{ar ? "مصدر منتجك ↗" : "Your product source ↗"}</a><a href={rival.sourceUrl} target="_blank" rel="noreferrer">{ar ? "مصدر منتج المنافس ↗" : "Rival product source ↗"}</a></footer></section>)}</div> : <div className="product-decision-empty"><strong>{ar ? "لا توجد مقارنة موثوقة حتى الآن" : "No defensible product match yet"}</strong><p>{ar ? "وجد الزاحف منتجات، لكن التشابه غير كافٍ لإصدار مقارنة شرائية دون تخمين." : "The crawler found products, but none were similar enough to support a buying-decision comparison without guessing."}</p></div>}</article>;
}

function AdIntelligenceBlock({ block, locale }: { block: JsonBlock; locale: Locale }) {
  const primaryDomain = jsonText(block, "primaryDomain");
  const companies = jsonList(block, "companies").map(object).filter((company) => String(company.domain) !== primaryDomain);
  const verifiedCount = companies.reduce((sum, company) => sum + (Array.isArray(company.platforms) ? company.platforms.map(object).filter((platform) => platform.status === "verified-active").length : 0), 0);
  const ar = locale === "ar";
  return <article className="json-block ad-intelligence-block" key={block.id}><div className="json-block-heading"><div><span className="json-block-type">{ar ? "مكتبات الإعلانات الرسمية" : "OFFICIAL AD LIBRARIES"}</span><h4>{ar ? "ما الذي يروّج له منافسوك الآن؟" : "What your competitors are actively promoting"}</h4></div><span className={`ad-scan-state ${verifiedCount ? "has-ads" : ""}`}>{verifiedCount ? (ar ? `${verifiedCount} نتائج موثقة` : `${verifiedCount} verified platform result${verifiedCount === 1 ? "" : "s"}`) : (ar ? "لم يتم توثيق إعلان تلقائياً" : "No creative verified automatically")}</span></div><p className="product-coverage-note">{ar ? "بحثنا في مكتبات Meta وGoogle وTikTok الرسمية. عدم العثور على نتيجة لا يعني عدم وجود إعلانات." : "Searched Meta Ad Library, Google Ads Transparency Center, and TikTok Commercial Content Library. A missing result is never treated as zero advertising."}</p><div className="ad-company-grid">{companies.map((company) => <section className="ad-company-card" key={String(company.domain)}><header><div><span>{ar ? "منافس" : "COMPETITOR"}</span><strong>{String(company.brand || company.domain)}</strong><small>{String(company.domain)}</small></div></header><p dir="auto">{String(company.summary || (ar ? "لم يتم توثيق إعلان نشط بشكل مستقل." : "No active creative was independently verified."))}</p><div className="ad-platform-list">{(Array.isArray(company.platforms) ? company.platforms : []).map((value) => { const platform = object(value); const active = platform.status === "verified-active"; const evidenceUrls = Array.isArray(platform.evidenceUrls) ? platform.evidenceUrls.map(String) : []; return <div className={active ? "ad-platform-active" : ""} key={String(platform.platform)}><div><strong>{String(platform.platform)}</strong><span>{active ? (ar ? `${Number(platform.activeCreativeCount || 0)} إعلانات نشطة` : `${Number(platform.activeCreativeCount || 0)} active creative${Number(platform.activeCreativeCount || 0) === 1 ? "" : "s"}`) : platform.status === "access-limited" ? (ar ? "الوصول محدود" : "Access limited") : (ar ? "غير موثق" : "Not verified")}</span></div>{Array.isArray(platform.themes) && platform.themes.length > 0 && <p>{platform.themes.map(String).join(" · ")}</p>}{active && evidenceUrls.length > 0 && <div className="ad-record-links">{evidenceUrls.map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={url}>{ar ? `دليل الإعلان ${index + 1} ↗` : `Direct ad record ${index + 1} ↗`}</a>)}</div>}<a href={String(platform.searchUrl || "#")} target="_blank" rel="noreferrer">{ar ? "افتح بحث المكتبة ↗" : "Open library search ↗"}</a></div>; })}</div><div className="ad-recommendation"><span>{ar ? "خطوتك التالية" : "YOUR NEXT MOVE"}</span><p dir="auto">{String(company.recommendedAction || (ar ? "راجع نتائج المكتبات الرسمية قبل اتخاذ قرار إعلاني." : "Review the official library searches before making a campaign decision."))}</p></div></section>)}</div><footer className="ad-limit-note">{ar ? "لا توفر مكتبات الإعلانات إنفاقاً دقيقاً للإعلانات التجارية العادية. بعض المنصات والمناطق تقيّد الوصول الآلي؛ لذلك نعرض فقط سجلات الإعلانات المباشرة التي أمكن توثيقها." : jsonText(block, "limitation")}</footer></article>;
}

function JsonReportRenderer({ document, locale }: { document: JsonReportDocument; locale: Locale }) {
  const ar = locale === "ar";
  return <section className="json-report" aria-label={ar ? "تقرير المنافسين" : "Adaptive competitor intelligence report"}><div className="json-report-header"><div><span className="eyebrow"><span className="pulse-dot" /> {ar ? "معلومات تنافسية مباشرة" : "Live competitor intelligence"}</span><h3>{ar ? "من ينافسك على العميل نفسه؟" : "Who is competing for the same customer?"}</h3></div><span className="json-report-version">{ar ? "أدلة مباشرة" : "live evidence"}</span></div><div className="json-blocks">{document.blocks.map((block) => {
    if (block.type === "summary") return <article className="json-block json-summary" key={block.id}><span className="json-block-type">{ar ? "نتيجة السوق" : "MARKET RESULT"}</span><h4 dir="auto">{jsonText(block, "title")}</h4><p dir="auto">{jsonText(block, "body")}</p></article>;
    if (block.type === "market-profile") return <article className="json-block market-profile-block" key={block.id}><div><span className="json-block-type">{ar ? "نطاق البحث" : "PRODUCT SEARCH SCOPE"}</span><h4>{jsonText(block, "category") || (ar ? "نحتاج أدلة إضافية لتحديد الفئة" : "Category needs more evidence")}</h4><p>{ar ? `نبحث عن بائعين يعرضون منتجات مماثلة في ${jsonText(block, "region")}.` : `Looking for sellers with matching products in ${jsonText(block, "region")}.`}</p></div>{jsonText(block, "gap") && <p className="json-gap">{jsonText(block, "gap")}</p>}</article>;
    if (block.type === "competitor") return <article className="json-block competitor-result-card" key={block.id}><div className="competitor-result-top"><div><span className="json-block-type">{ar ? "منافس بمنتج مطابق" : "PRODUCT-VERIFIED COMPETITOR"}</span><h4>{jsonText(block, "companyName") || jsonText(block, "domain")}</h4><a href={jsonText(block, "websiteSourceUrl", "#")} target="_blank" rel="noreferrer">{jsonText(block, "domain")} ↗</a></div><div className="verification-score"><strong>{jsonNumber(block, "verificationScore")}</strong><span>{ar ? "درجة التحقق" : "verification score"}</span></div></div><p dir="auto">{jsonText(block, "reason")}</p><div className="matched-product-proof"><span>{ar ? "زوج المنتجات الذي أثبت المنافسة" : "PRODUCT PAIR THAT PROVED THE COMPETITION"}</span><strong dir="auto">{jsonText(block, "matchedPrimaryProductName")} ↔ {jsonText(block, "matchedProductName")}</strong><a href={jsonText(block, "matchedProductUrl", "#")} target="_blank" rel="noreferrer">{ar ? "افتح منتج المنافس ↗" : "Open proven rival product ↗"}</a></div><div className="competitor-proof"><span><b>{jsonNumber(block, "productCount")}</b> {ar ? "منتجات عامة تم العثور عليها" : "public products discovered"}</span></div><div className="competitor-sources"><a href={jsonText(block, "discoverySourceUrl", "#")} target="_blank" rel="noreferrer">{ar ? "دليل البحث ↗" : "Search evidence ↗"}</a><Confidence value={jsonText(block, "confidence", "Low")} locale={locale} /></div></article>;
    if (block.type === "coverage" || block.type === "company" || block.type === "product-catalog" || block.type === "candidate" || block.type === "evidence") return null;
    if (block.type === "product-comparison") return <ProductComparisonBlock block={block} locale={locale} key={block.id} />;
    if (block.type === "product-unmatched") return null;
    if (block.type === "ad-intelligence") return <AdIntelligenceBlock block={block} locale={locale} key={block.id} />;
    if (block.type === "gap") return <article className="json-block json-gap" key={block.id}><div><span className="json-block-type">{ar ? "ملاحظة عن تغطية البيانات" : "DATA COVERAGE NOTE"}</span><h4>{jsonText(block, "domain") || (ar ? "فجوة في الجمع" : "Collection gap")}</h4></div><p dir="auto">{jsonText(block, "reason")}</p>{jsonText(block, "url") && <a href={jsonText(block, "url")} target="_blank" rel="noreferrer">{ar ? "افحص الرابط المطلوب ↗" : "Inspect requested URL ↗"}</a>}</article>;
    return null;
  })}</div></section>;
}

export default function Home() {
  const [locale, setLocale] = useState<Locale>("en");
  const [domain, setDomain] = useState("");
  const [reportDomain, setReportDomain] = useState<string | null>(null);
  const [liveAnalysis, setLiveAnalysis] = useState<LiveAnalysis | null>(null);
  const [comparisonResults, setComparisonResults] = useState<CrawlPage[]>([]);
  const [crawlDocument, setCrawlDocument] = useState<JsonReportDocument | null>(null);
  const [marketBrief, setMarketBrief] = useState<MarketBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [toast, setToast] = useState("");

  const companyName = useMemo(() => getCompanyName(reportDomain ?? domain), [domain, reportDomain]);
  const competitorResults = useMemo(() => comparisonResults.filter((result) => result.domain !== liveAnalysis?.domain), [comparisonResults, liveAnalysis]);
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
    setComparisonResults([]);
    try {
      const response = await fetch("/api/crawl", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ primary: cleanDomain, domains: requestedDomains }) });
      const payload = await response.json() as CrawlPayload | CrawlFailure;
      if (!payload.ok) {
        if (payload.document) setCrawlDocument(payload.document);
        if (payload.results) setComparisonResults(payload.results.flatMap((result) => result.homepage ? [result.homepage] : []));
        setReportDomain(cleanDomain);
        setAnalysisError(payload.error || "The public crawl could not be completed.");
        window.setTimeout(() => document.getElementById("report")?.scrollIntoView({ behavior: "smooth" }), 50);
        return;
      }
      const crawlResults = payload.results;
      const successful = crawlResults.flatMap((result) => result.homepage ? [result.homepage] : []);
      const primaryHost = payload.primaryDomain;
      const primaryResult = successful.find((result) => result.domain === primaryHost);
      if (!primaryResult) throw new Error(`Primary domain ${cleanDomain} could not be crawled: ${crawlResults.find((result) => result.domain === primaryHost)?.gaps[0]?.reason || "no live result was returned"}`);
      setComparisonResults(successful);
      setLiveAnalysis(primaryResult);
      setCrawlDocument(payload.document);
      setReportDomain(cleanDomain);
      setBriefLoading(true);
      try {
        const briefResponse = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ primary: primaryResult.domain, domains: successful.map((result) => result.domain) }) });
        const briefPayload = await briefResponse.json() as MarketBrief | { ok: false; error?: string };
        if (briefPayload.ok) setMarketBrief(briefPayload);
        else setAnalysisError(briefPayload.error || "The source scan completed, but the market brief was unavailable.");
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
          <span className="brand-mark"><i /><i /><i /></span>
          <span>Market Signal</span>
          <span className="beta-pill">BETA</span>
        </a>
        <nav className="header-nav" aria-label={ar ? "التنقل الرئيسي" : "Primary navigation"}>
          <a href="#report">{ar ? "التقرير" : "Live report"}</a>
          <a href="#method">{ar ? "منهجنا" : "Our method"}</a>
          <button className="language-switch" type="button" onClick={() => setLocale(ar ? "en" : "ar")} aria-label={ar ? "Switch to English" : "التبديل إلى العربية"}><span aria-hidden="true">{ar ? "EN" : "ع"}</span>{ar ? "English" : "العربية"}</button>
          <button className="quiet-button" onClick={() => showToast(ar ? "ستتوفر الحسابات بعد أن يثبت التقرير قيمته." : "Accounts arrive after the report proves value.")}>{ar ? "تسجيل الدخول لاحقاً" : "Sign in later"} <span>↗</span></button>
        </nav>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span className="pulse-dot" /> {ar ? "معلومات تنافسية لمن يريد الإجابة الآن" : "Competitive intelligence for the impatient"}</div>
          <h1>{ar ? <>اعرف إلى أين يتحرك سوقك <em>قبل أن يسبقك.</em></> : <>Know where your market is moving <em>before it moves you.</em></>}</h1>
          <p className="hero-lede">{ar ? "أدخل نطاق شركتك. سنجد منافسيك ونقارن المنتجات والأسعار والإعلانات العامة ونوضح لك ما الذي يجب فعله." : "Enter a domain. Get the competitive picture behind the noise: who is gaining ground, what they sell, what they charge, and how they show up in public."}</p>
          <form className="domain-form" onSubmit={analyze}>
            <label htmlFor="domain">{ar ? "نطاق شركتك أو رابط الموقع" : "Your company domain or URL"}</label>
            <div className="input-row">
              <div className="domain-input"><input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder={ar ? "example.com أو الصق الرابط الكامل" : "yourcompany.com or paste the full URL"} dir="ltr" /></div>
              <button className="primary-button" type="submit" disabled={isAnalyzing}>{isAnalyzing ? (ar ? "جارٍ البحث والتحقق…" : "Finding and verifying rivals…") : (ar ? "ابحث عن منافسيّ" : "Find my competitors")} <span>{isAnalyzing ? "·" : (ar ? "←" : "→")}</span></button>
            </div>
            <div className="form-note"><span className="lock">◇</span> {ar ? "تقرير مجاني · دون حساب · بيانات عامة فقط" : "One free report · no account required · public signals only"}</div>
            {analysisError && <div className="analysis-error" role="alert">{analysisError}</div>}
          </form>
          <div className="trusted-row"><span>{ar ? "مصمم للفرق التي تحتاج سياقاً تنافسياً عميقاً" : "Built for teams who need an unfair amount of context"}</span><span className="trusted-line" /><span>{ar ? "الشركات الناشئة" : "STARTUPS"}</span><span>{ar ? "الوكالات" : "AGENCIES"}</span><span>{ar ? "التجارة الإلكترونية" : "ECOMMERCE"}</span></div>
        </div>
        <div className="hero-preview method-preview" aria-label="How Market Signal collects evidence">
          <div className="preview-top"><span className="window-dot coral" /><span className="window-dot amber" /><span className="window-dot green" /><span className="preview-label">{ar ? "السوق / منهج الأدلة" : "MARKET / EVIDENCE METHOD"}</span><span className="preview-time">{ar ? "بيانات عامة فقط" : "public only"}</span></div>
          <div className="preview-body">
            <div className="preview-kicker">{ar ? "لا بيانات سوق مخترعة" : "NO INVENTED MARKET DATA"}</div>
            <div className="preview-title">{ar ? <>تقرير مبني على <strong>ما يظهره الويب فعلاً.</strong></> : <>A report built from <strong>what the web actually shows.</strong></>}</div>
            <div className="method-preview-list"><div><b>01</b><span>{ar ? "نجمع الصفحات العامة والروابط والأسعار والتوقيتات." : "Collect public pages, links, pricing patterns, and timestamps."}</span></div><div><b>02</b><span>{ar ? "نربط الأدلة بين النطاقات واللقطات الزمنية." : "Connect claims across domains and historical snapshots."}</span></div><div><b>03</b><span>{ar ? "نشرح فقط ما تدعمه الأدلة." : "Explain only what the evidence can support."}</span></div></div>
            <div className="preview-foot"><span><b>{ar ? "مباشر" : "LIVE"}</b> {ar ? "بعد إرسال النطاق" : "after you submit a domain"}</span><span><b>{ar ? "عام" : "PUBLIC"}</b> {ar ? "مسار المصادر" : "source trail"}</span><span><b>{ar ? "دون" : "NO"}</b> {ar ? "نتائج مؤقتة" : "fixture results"}</span></div>
          </div>
        </div>
      </section>

      <section className={`report-section shell ${reportDomain ? "report-visible" : ""}`} id="report" aria-live="polite">
        <div className="report-header">
          <div><div className="eyebrow"><span className="pulse-dot" /> {ar ? "تقرير المشهد التنافسي" : "Competitive landscape report"}</div><h2>{liveAnalysis ? (ar ? `${companyName} في مواجهة السوق.` : `${companyName} against the market.`) : (ar ? "تقرير يبدأ برابط واحد." : "A report that starts with one URL.")}</h2><p>{liveAnalysis ? (ar ? "بحثنا في السوق المتوقع، وتحققنا من مواقع المنافسين، وقارنّا المنتجات العامة المنسوبة إليهم." : "We searched the inferred market, verified candidate websites, and compared the public products we could attribute.") : (ar ? "أرسل نطاقاً واحداً وسنجد المنافسين ونتحقق منهم نيابةً عنك." : "Submit one domain. Market Signal finds and verifies the competitors for you.")}</p></div>
          <div className="report-actions"><button className="secondary-button" onClick={() => showToast(ar ? "سيصبح التصدير متاحاً عند اكتمال ربط الأدلة المباشرة." : "Export is ready when live evidence is connected.")}>{ar ? "تصدير التقرير" : "Export report"} <span>↓</span></button><button className="secondary-button" onClick={() => showToast(ar ? "ستتوفر المراقبة الأسبوعية في الإصدار القادم." : "Weekly monitoring is available in the next release.")}>{ar ? "تحديد وتيرة المتابعة" : "Set cadence"} <span>⌄</span></button></div>
        </div>

        <div className="metric-grid">
          <div className="metric-card"><span className="metric-label">{ar ? "منافسون موثقون" : "Verified competitors"}</span><strong>{liveAnalysis ? competitorResults.length : "—"}</strong><div className="metric-trend positive">{liveAnalysis ? (ar ? "تم العثور عليهم وزحف مواقعهم" : "Discovered and crawled") : (ar ? "بانتظار البحث" : "Waiting for market search")}</div></div>
          <div className="metric-card"><span className="metric-label">{ar ? "مواقع تم فحصها" : "Sites investigated"}</span><strong>{liveAnalysis ? comparisonResults.length : "—"}</strong><div className="metric-trend">{liveAnalysis ? (ar ? "موقعك والمنافسون الموثقون" : "Primary plus verified rivals") : (ar ? "لم يبدأ البحث" : "No search yet")}</div></div>
          <div className="metric-card"><span className="metric-label">{ar ? "منتجات تم رصدها" : "Products observed"}</span><strong>{liveAnalysis ? comparisonResults.reduce((sum, result) => sum + result.products.length, 0) : "—"}</strong><div className="metric-trend">{liveAnalysis ? (ar ? "سجلات عامة منسوبة للمصدر" : "Attributable public records") : (ar ? "لم يبدأ الزحف" : "No crawl yet")}</div></div>
          <div className="metric-card accent-card"><span className="metric-label">{ar ? "وضع الأدلة" : "Evidence mode"}</span><strong>{liveAnalysis ? (ar ? "مباشر" : "LIVE") : "—"}</strong><div className="metric-trend">{ar ? "بحث وزحف مستقل" : "Search + independent crawl"}</div></div>
        </div>

        {crawlDocument && <JsonReportRenderer document={crawlDocument} locale={locale} />}

        {liveAnalysis && <section className="panel ai-brief-panel"><div className="panel-heading"><div><span className="section-number">AI</span><h3>{ar ? "ما الذي تغير في سوقك؟" : "What changed in your market?"}</h3></div><span className={`brief-mode ${marketBrief?.aiGenerated ? "brief-mode-ai" : ""}`}>{briefLoading ? (ar ? "جارٍ التحليل…" : "Synthesizing…") : marketBrief?.aiGenerated ? (ar ? "نموذج قياسي" : "Standard model") : (ar ? "تحليل مؤسس على الأدلة" : "Grounded demo")}</span></div>{briefLoading && <div className="brief-loading"><span className="pulse-dot" /> {ar ? "نربط الأدلة المرصودة في ملخص يساعدك على القرار." : "Connecting observed claims into a decision-ready brief."}</div>}{marketBrief && <><div className="brief-hero" dir="auto"><h4>{marketBrief.headline}</h4><p>{marketBrief.summary}</p></div><div className="signal-grid">{marketBrief.signals.map((signal) => <article className="signal-card" key={signal.label} dir="auto"><div className="signal-card-label">{signal.label}</div><p>{signal.text}</p><strong>{ar ? "لماذا يهم؟" : "Why it matters"}</strong><span>{signal.implication}</span><div className="signal-sources">{signal.claimIds.map((claimId) => { const claim = marketBrief.claims.find((item) => item.id === claimId); return claim ? <a href={claim.sourceUrl} target="_blank" rel="noreferrer" key={claim.id} title={claim.text}>{ar ? "المصدر" : "Source"} {marketBrief.claims.indexOf(claim) + 1} ↗</a> : null; })}</div></article>)}</div><div className="brief-footer"><div><span className="live-source-label">{ar ? "الأدلة التالية المطلوب جمعها" : "Next evidence to collect"}</span><ul dir="auto">{marketBrief.nextChecks.map((check) => <li key={check}>{check}</li>)}</ul></div><div className="brief-ledger"><span className="live-source-label">{ar ? "سجل الأدلة" : "Evidence ledger"}</span><strong>{ar ? `${marketBrief.claims.length} ادعاءات مؤسسة على أدلة` : `${marketBrief.claims.length} grounded claims`}</strong><span>{ar ? "كل استنتاج أعلاه يعود إلى مصدر عام." : "Every insight above resolves to a public source."}</span></div></div></>}</section>}

        {comparisonResults.length > 0 && <section className="evidence-strip live-evidence-strip" id="method"><div><span className="section-number">{ar ? "مباشر" : "LIVE"}</span><strong>{ar ? "المصادر المرصودة" : "Observed sources"}</strong><span className="evidence-sub">{ar ? "مسار لكل نطاق تم فحصه." : "One trail per scanned domain."}</span></div><div className="evidence-items">{comparisonResults.map((result) => <div className="evidence-item" key={result.domain}><span className="evidence-tag evidence-observed">{ar ? "مرصود" : "Observed"}</span><strong>{result.domain}</strong><span>{new Date(result.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><Confidence value="High" locale={locale} /></div>)}</div></section>}
      </section>

      <section className="method-section shell"><div className="method-copy"><div className="eyebrow">{ar ? "الإشارة، لا الضوضاء" : "The signal, not the spectacle"}</div><h2>{ar ? <>شاهد ما نعرفه.<br /><em>وشاهد كيف عرفناه.</em></> : <>See what we know.<br /><em>See how we know it.</em></>}</h2><p>{ar ? "يفصل Market Signal بين الرصد العام واستنتاجات الذكاء الاصطناعي والتقديرات والتوصيات، ليحوّل الإجابة السريعة إلى قرار مفيد." : "Market Signal separates public observations from AI inferences, estimates, and recommendations. That is how a fast answer becomes a useful one."}</p></div><div className="method-steps"><div><span>01</span><strong>{ar ? "نجمع" : "Collect"}</strong><p>{ar ? "المواقع العامة وصفحات الأسعار ونتائج البحث ومكتبات الإعلانات." : "Public websites, pricing pages, search landscapes, and ad libraries."}</p></div><div><span>02</span><strong>{ar ? "نربط" : "Connect"}</strong><p>{ar ? "نوحد الأدلة بين المناطق والقنوات وأنماط المنافسين." : "Normalize evidence across regions, channels, and competitor patterns."}</p></div><div><span>03</span><strong>{ar ? "نشرح" : "Explain"}</strong><p>{ar ? "نحوّل الإشارة إلى قرار يمكنك تنفيذه هذا الأسبوع." : "Turn the signal into a decision your team can act on this week."}</p></div></div></section>

      <footer className="site-footer shell"><a className="brand" href="#top"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></a><span>{ar ? "معلومات عامة تتحول إلى قرار مفيد." : "Public intelligence, made useful."}</span><span>© 2026 Market Signal</span></footer>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
