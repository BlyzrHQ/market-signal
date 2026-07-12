"use client";

import { FormEvent, useMemo, useState } from "react";

type ClaimType = "Observed" | "Inferred" | "Estimated" | "Recommended";

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
type ProductView = { id: string; domain: string; name: string; description: string; category: string; jsonLdType: string; priceSignals: Array<{ raw: string }>; attributes: string[]; ownership: string; extraction: string; confidence: "High" | "Medium"; sourceUrl: string; observedAt: string; claimIds: string[] };
type CrawlPage = LiveAnalysis & { url: string; path: string; contentHash: string; claims: BriefClaim[]; products: ProductView[]; productGaps: string[]; thirdPartyProductCount: number };
type CrawlDomain = { domain: string; role: "primary" | "submitted-comparison" | "discovered-competitor"; homepage: CrawlPage | null; pages: CrawlPage[]; products: ProductView[]; candidates: Array<{ domain: string; reason: string; sourceUrl: string; claimIds: string[] }>; gaps: Array<{ url: string; reason: string; observedAt: string }>; coverage: { pagesRequested: number; pagesFetched: number; maxPages: number; robotsChecked: boolean }; productCoverage: { scannedPages: number; thirdPartyReferenced: number }; fetchedAt: string; discovery?: { verificationScore: number; confidence: "High" | "Medium" | "Low"; overlapTerms: string[] } };
type JsonBlock = { type: string; id: string } & Record<string, unknown>;
type JsonReportDocument = { version: "1"; generatedAt: string; blocks: JsonBlock[] };
type CrawlPayload = { ok: true; live: true; primaryDomain: string; results: CrawlDomain[]; document: JsonReportDocument; discovery: { available: boolean; category: string; region: string; queries: string[]; gap?: string }; crawl: { maxPagesPerDomain: number; robotsAware: boolean; generatedAt: string } };
type CrawlFailure = { ok: false; live: false; error: string; results?: CrawlDomain[]; document?: JsonReportDocument };

function getCompanyName(domain: string) {
  const clean = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split(".")[0];
  if (!clean) return "your company";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function getDomainHost(domain: string) {
  try {
    return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).hostname.toLowerCase();
  } catch {
    return domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  }
}

function getCollectionMoves(result: LiveAnalysis) {
  return [
    { title: result.prices.length ? "Verify the pricing surface" : "Collect the pricing surface", body: result.prices.length ? `${result.prices.length} price pattern${result.prices.length === 1 ? "" : "s"} appeared on the scanned page. Confirm the same plan on a pricing page before comparing.` : "No price pattern appeared on the scanned page. A pricing-page crawl is required before making a price claim." },
    { title: result.headings.length ? "Track the message over time" : "Find the page message", body: result.headings.length ? `${result.headings.length} H1–H3 heading${result.headings.length === 1 ? " was" : "s were"} observed. Save this snapshot before calling a messaging change.` : "The page exposed no H1–H3 headings. The next crawl should use the sitemap to find the public product message." },
    { title: result.socialLinks.length ? "Follow the linked profiles" : "Connect public social sources", body: result.socialLinks.length ? `${result.socialLinks.length} public social link${result.socialLinks.length === 1 ? " is" : "s are"} visible from the page. Fetch those profiles before estimating attention or ad pressure.` : "No social profile links were exposed. Social and ad conclusions remain uncollected, not zero." },
  ];
}

function Confidence({ value }: { value: string }) {
  return <span className={`confidence confidence-${value.toLowerCase()}`}><span />{value} confidence</span>;
}

function EvidenceTag({ type }: { type: ClaimType }) {
  return <span className={`evidence-tag evidence-${type.toLowerCase()}`}>{type}</span>;
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
  return { item, name: String(item.name || "Observed product"), domain: String(item.domain || ""), description: String(item.description || ""), category: String(item.category || "Uncategorized"), sourceUrl: String(item.sourceUrl || "#"), extraction: String(item.extraction || "page-signal"), confidence: String(item.confidence || "Medium"), prices: Array.isArray(item.priceSignals) ? item.priceSignals.map((signal) => String(object(signal).raw || "")).filter(Boolean) : [], attributes: Array.isArray(item.attributes) ? item.attributes.map(String) : [] };
}

function ProductCatalogBlock({ block }: { block: JsonBlock }) {
  const items = jsonList(block, "products").map(product);
  return <article className="json-block product-catalog-block" key={block.id}><div className="json-block-heading"><div><span className="json-block-type">OBSERVED PRODUCT CATALOG</span><h4>{jsonText(block, "domain")}</h4></div><span className="coverage-state coverage-live">{jsonNumber(block, "scannedPages")} pages</span></div><p className="product-coverage-note">{jsonText(block, "coverageNote")}</p>{jsonNumber(block, "thirdPartyReferenced") > 0 && <p className="product-third-party">{jsonNumber(block, "thirdPartyReferenced")} third-party product record{jsonNumber(block, "thirdPartyReferenced") === 1 ? " was" : "s were"} excluded from this company&apos;s own catalog.</p>}<div className="product-catalog-grid">{items.length ? items.map((entry, index) => <a className="product-card" href={entry.sourceUrl} target="_blank" rel="noreferrer" key={`${block.id}-product-${index}`}><div><span>{entry.extraction === "json-ld" ? "Structured" : "Page signal"}</span><b>{entry.confidence}</b></div><strong>{entry.name}</strong><p>{entry.description || "No public description was exposed."}</p><small>{entry.category}</small><div className="product-price-chips">{(entry.prices.length ? entry.prices : ["No public price observed"]).slice(0, 4).map((price) => <em key={price}>{price}</em>)}</div><footer>Open product source ↗</footer></a>) : <div className="product-empty"><strong>No attributable products observed</strong><span>The scan did not manufacture catalog items from generic pages.</span></div>}</div></article>;
}

function ProductComparisonBlock({ block }: { block: JsonBlock }) {
  const rows = jsonList(block, "rows");
  const competitors = jsonList(block, "comparisonDomains").map(String);
  return <article className="json-block product-comparison-block" key={block.id}><div className="json-block-heading"><div><span className="json-block-type">PRODUCT-BY-PRODUCT</span><h4>Your products against the closest observed matches</h4></div><EvidenceTag type="Inferred" /></div><p className="product-coverage-note">Rows come from {jsonText(block, "primaryDomain")}. Matches are deterministic suggestions, not equivalence claims.</p><div className="product-matrix">{rows.map((row, rowIndex) => { const rowItem = object(row); const primary = product(rowItem.primary); const matches = Array.isArray(rowItem.matches) ? rowItem.matches : []; return <section className="product-comparison-row" key={`${block.id}-row-${rowIndex}`}><div className="primary-product-cell"><span>YOUR PRODUCT</span><strong>{primary.name}</strong><p>{primary.description || primary.category}</p><div className="product-price-chips">{(primary.prices.length ? primary.prices : ["No public price observed"]).slice(0, 3).map((price) => <em key={price}>{price}</em>)}</div><a href={primary.sourceUrl} target="_blank" rel="noreferrer">Primary source ↗</a></div><div className="competitor-match-grid">{competitors.map((domain, competitorIndex) => { const match = object(matches.find((candidate) => String(object(candidate).domain) === domain) || matches[competitorIndex]); const matchedProduct = match.product ? product(match.product) : null; const score = typeof match.score === "number" ? Math.round(match.score * 100) : 0; const sharedTerms = Array.isArray(match.sharedTerms) ? match.sharedTerms.map(String) : []; return <div className={`competitor-product-cell ${matchedProduct ? "has-match" : "no-match"}`} key={`${block.id}-${rowIndex}-${domain}`}><div className="competitor-match-heading"><span>{domain}</span>{matchedProduct && <b>{score}% signal overlap</b>}</div>{matchedProduct ? <><small>CLOSEST OBSERVED MATCH · INFERRED</small><strong>{matchedProduct.name}</strong><p>{matchedProduct.description || matchedProduct.category}</p><div className="product-price-chips">{(matchedProduct.prices.length ? matchedProduct.prices : ["No public price observed"]).slice(0, 3).map((price) => <em key={price}>{price}</em>)}</div><div className="shared-term-list">{sharedTerms.map((term) => <span key={term}>{term}</span>)}</div><a href={matchedProduct.sourceUrl} target="_blank" rel="noreferrer">Matched source ↗</a></> : <><small>NO FORCED MATCH</small><strong>No comparable public product observed</strong><p>The bounded crawl found no item above the evidence threshold for this row.</p></>}</div>; })}</div></section>; })}</div></article>;
}

function ProductUnmatchedBlock({ block }: { block: JsonBlock }) {
  const items = jsonList(block, "products").map(product);
  return <article className="json-block product-unmatched-block" key={block.id}><span className="json-block-type">UNMATCHED COMPETITOR PRODUCTS</span><h4>{jsonText(block, "domain")}</h4><p>{jsonText(block, "reason")}</p><div className="unmatched-product-list">{items.map((entry, index) => <a href={entry.sourceUrl} target="_blank" rel="noreferrer" key={`${block.id}-${index}`}><strong>{entry.name}</strong><span>{entry.category}</span></a>)}</div></article>;
}

function JsonReportRenderer({ document }: { document: JsonReportDocument }) {
  return <section className="json-report" aria-label="Adaptive competitor intelligence report"><div className="json-report-header"><div><span className="eyebrow"><span className="pulse-dot" /> Live competitor intelligence</span><h3>Who is competing for the same customer?</h3></div><span className="json-report-version">live evidence</span></div><div className="json-blocks">{document.blocks.map((block) => {
    if (block.type === "summary") return <article className="json-block json-summary" key={block.id}><span className="json-block-type">MARKET RESULT</span><h4>{jsonText(block, "title")}</h4><p>{jsonText(block, "body")}</p></article>;
    if (block.type === "market-profile") return <article className="json-block market-profile-block" key={block.id}><div><span className="json-block-type">INFERRED MARKET</span><h4>{jsonText(block, "category") || "Category needs more evidence"}</h4><p>{jsonText(block, "region")}</p></div><div className="market-query-list">{jsonList(block, "queries").map((query) => <span key={String(query)}>{String(query)}</span>)}</div>{jsonText(block, "gap") && <p className="json-gap">{jsonText(block, "gap")}</p>}</article>;
    if (block.type === "competitor") return <article className="json-block competitor-result-card" key={block.id}><div className="competitor-result-top"><div><span className="json-block-type">VERIFIED COMPETITOR</span><h4>{jsonText(block, "companyName") || jsonText(block, "domain")}</h4><a href={jsonText(block, "websiteSourceUrl", "#")} target="_blank" rel="noreferrer">{jsonText(block, "domain")} ↗</a></div><div className="verification-score"><strong>{jsonNumber(block, "verificationScore")}</strong><span>verification score</span></div></div><p>{jsonText(block, "reason")}</p><div className="competitor-proof"><span>Found through <b>{jsonText(block, "searchQuery")}</b></span><span><b>{jsonNumber(block, "productCount")}</b> products observed</span><span><b>{jsonList(block, "overlapTerms").length}</b> shared market terms</span></div><div className="shared-term-list">{jsonList(block, "overlapTerms").slice(0, 8).map((term) => <span key={String(term)}>{String(term)}</span>)}</div><div className="competitor-sources"><a href={jsonText(block, "discoverySourceUrl", "#")} target="_blank" rel="noreferrer">Discovery evidence ↗</a><Confidence value={jsonText(block, "confidence", "Low")} /></div></article>;
    if (block.type === "coverage") return <article className="json-block json-coverage" key={block.id}><div className="json-block-heading"><div><span className="json-block-type">COVERAGE</span><h4>{jsonText(block, "domain")}</h4></div><span className="coverage-state coverage-live">{jsonText(block, "role") === "primary" ? "Primary" : "Compared"}</span></div><div className="json-coverage-metrics"><span><b>{jsonNumber(block, "pagesFetched")}</b> pages fetched</span><span><b>{jsonNumber(block, "pagesRequested")}</b> requested</span><span><b>{jsonNumber(block, "maxPages")}</b> per-domain cap</span><span><b>{jsonText(block, "robotsChecked") === "true" || block.robotsChecked ? "Yes" : "No"}</b> robots checked</span></div>{jsonList(block, "gaps").map((gap, index) => { const item = gap as Record<string, unknown>; return <div className="json-gap" key={`${block.id}-gap-${index}`}><strong>Coverage gap</strong><span>{String(item.reason ?? "Page not collected")}</span></div>; })}</article>;
    if (block.type === "company") return <article className="json-block json-company" key={block.id}><div className="json-block-heading"><div><span className="json-block-type">COMPANY PROFILE</span><h4>{jsonText(block, "domain")}</h4></div><EvidenceTag type="Observed" /></div><strong className="json-company-title">{jsonText(block, "title")}</strong><p>{jsonText(block, "description")}</p><div className="json-page-list">{jsonList(block, "pages").map((page, index) => { const item = page as Record<string, unknown>; return <a href={String(item.url ?? "#")} target="_blank" rel="noreferrer" key={`${block.id}-page-${index}`}><span>{String(item.path ?? "/")}</span><strong>{String(item.title ?? "Observed page")}</strong><small>{Array.isArray(item.claimIds) ? item.claimIds.length : 0} claims</small></a>; })}</div></article>;
    if (block.type === "product-catalog") return <ProductCatalogBlock block={block} key={block.id} />;
    if (block.type === "product-comparison") return <ProductComparisonBlock block={block} key={block.id} />;
    if (block.type === "product-unmatched") return <ProductUnmatchedBlock block={block} key={block.id} />;
    if (block.type === "candidate") return <article className="json-block json-candidate" key={block.id}><div className="json-block-heading"><div><span className="json-block-type">POSSIBLE CANDIDATE</span><h4>{jsonText(block, "domain")}</h4></div><EvidenceTag type="Inferred" /></div><p>{jsonText(block, "reason")}</p><a href={jsonText(block, "sourceUrl", "#")} target="_blank" rel="noreferrer">Open justifying source ↗</a></article>;
    if (block.type === "evidence") return <article className="json-block json-evidence" key={block.id}><div><span className="json-block-type">{jsonText(block, "claimType", "Observed").toUpperCase()}</span><p>{jsonText(block, "text")}</p></div><div className="json-evidence-meta"><a href={jsonText(block, "sourceUrl", "#")} target="_blank" rel="noreferrer">Source ↗</a><span>{jsonText(block, "confidence")} confidence</span><time>{jsonText(block, "observedAt")}</time></div></article>;
    return <article className="json-block json-gap" key={block.id}><div><span className="json-block-type">DATA GAP</span><h4>{jsonText(block, "domain") || "Collection gap"}</h4></div><p>{jsonText(block, "reason")}</p>{jsonText(block, "url") && <a href={jsonText(block, "url")} target="_blank" rel="noreferrer">Inspect requested URL ↗</a>}</article>;
  })}</div></section>;
}

export default function Home() {
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
      const primaryHost = getDomainHost(cleanDomain);
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
    <main>
      <header className="site-header shell">
        <a className="brand" href="#top" aria-label="Market Signal home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>Market Signal</span>
          <span className="beta-pill">BETA</span>
        </a>
        <nav className="header-nav" aria-label="Primary navigation">
          <a href="#report">Live report</a>
          <a href="#method">Our method</a>
          <button className="quiet-button" onClick={() => showToast("Accounts arrive after the report proves value.")}>Sign in later <span>↗</span></button>
        </nav>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span className="pulse-dot" /> Competitive intelligence for the impatient</div>
          <h1>Know where your market is moving <em>before it moves you.</em></h1>
          <p className="hero-lede">Enter a domain. Get the competitive picture behind the noise: who is gaining ground, what they sell, what they charge, and how they show up in public.</p>
          <form className="domain-form" onSubmit={analyze}>
            <label htmlFor="domain">Your company domain or URL</label>
            <div className="input-row">
              <div className="domain-input"><input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="yourcompany.com or paste the full URL" /></div>
              <button className="primary-button" type="submit" disabled={isAnalyzing}>{isAnalyzing ? "Finding and verifying rivals…" : "Find my competitors"} <span>{isAnalyzing ? "·" : "→"}</span></button>
            </div>
            <div className="form-note"><span className="lock">◇</span> One free report · no account required · public signals only</div>
            {analysisError && <div className="analysis-error" role="alert">{analysisError}</div>}
          </form>
          <div className="trusted-row"><span>Built for teams who need an unfair amount of context</span><span className="trusted-line" /><span>STARTUPS</span><span>AGENCIES</span><span>ECOMMERCE</span></div>
        </div>
        <div className="hero-preview method-preview" aria-label="How Market Signal collects evidence">
          <div className="preview-top"><span className="window-dot coral" /><span className="window-dot amber" /><span className="window-dot green" /><span className="preview-label">MARKET / EVIDENCE METHOD</span><span className="preview-time">public only</span></div>
          <div className="preview-body">
            <div className="preview-kicker">NO INVENTED MARKET DATA</div>
            <div className="preview-title">A report built from <strong>what the web actually shows.</strong></div>
            <div className="method-preview-list"><div><b>01</b><span>Collect public pages, links, pricing patterns, and timestamps.</span></div><div><b>02</b><span>Connect claims across domains and historical snapshots.</span></div><div><b>03</b><span>Explain only what the evidence can support.</span></div></div>
            <div className="preview-foot"><span><b>LIVE</b> after you submit a domain</span><span><b>PUBLIC</b> source trail</span><span><b>NO</b> fixture results</span></div>
          </div>
        </div>
      </section>

      <section className={`report-section shell ${reportDomain ? "report-visible" : ""}`} id="report" aria-live="polite">
        <div className="report-header">
          <div><div className="eyebrow"><span className="pulse-dot" /> Competitive landscape report</div><h2>{liveAnalysis ? `${companyName} against the market.` : "A report that starts with one URL."}</h2><p>{liveAnalysis ? `We searched the inferred market, verified candidate websites, and compared the public products we could attribute.` : "Submit one domain. Market Signal finds and verifies the competitors for you."}</p></div>
          <div className="report-actions"><button className="secondary-button" onClick={() => showToast("Export is ready when live evidence is connected.")}>Export report <span>↓</span></button><button className="secondary-button" onClick={() => showToast("Weekly monitoring is available in the next release.")}>Set cadence <span>⌄</span></button></div>
        </div>

        <div className="metric-grid">
          <div className="metric-card"><span className="metric-label">Verified competitors</span><strong>{liveAnalysis ? competitorResults.length : "—"}</strong><div className="metric-trend positive">{liveAnalysis ? "Discovered and crawled" : "Waiting for market search"}</div></div>
          <div className="metric-card"><span className="metric-label">Sites investigated</span><strong>{liveAnalysis ? comparisonResults.length : "—"}</strong><div className="metric-trend">{liveAnalysis ? "Primary plus verified rivals" : "No search yet"}</div></div>
          <div className="metric-card"><span className="metric-label">Products observed</span><strong>{liveAnalysis ? comparisonResults.reduce((sum, result) => sum + result.products.length, 0) : "—"}</strong><div className="metric-trend">{liveAnalysis ? "Attributable public records" : "No crawl yet"}</div></div>
          <div className="metric-card accent-card"><span className="metric-label">Evidence mode</span><strong>{liveAnalysis ? "LIVE" : "—"}</strong><div className="metric-trend">Search + independent crawl</div></div>
        </div>

        {crawlDocument && <JsonReportRenderer document={crawlDocument} />}

        {liveAnalysis && <section className="panel live-source-panel"><div className="panel-heading"><div><span className="section-number">LIVE</span><h3>Public source scan</h3></div><EvidenceTag type="Observed" /></div><div className="live-source-grid"><div className="live-source-main"><span className="live-source-label">Page title</span><strong>{liveAnalysis.title}</strong><p>{liveAnalysis.description}</p><a href={liveAnalysis.sourceUrl} target="_blank" rel="noreferrer">Open observed source ↗</a></div><div className="live-fact"><span className="live-source-label">Language</span><strong>{liveAnalysis.language}</strong><span>{liveAnalysis.region}</span></div><div className="live-fact"><span className="live-source-label">Page words</span><strong>{liveAnalysis.wordCount.toLocaleString()}</strong><span>{liveAnalysis.truncated ? "First 1.5 MB scanned" : "Public HTML scanned"}</span></div><div className="live-fact"><span className="live-source-label">Social links</span><strong>{liveAnalysis.socialLinks.length}</strong><span>{liveAnalysis.socialLinks.length ? "Public profiles linked" : "None exposed"}</span></div></div><div className="live-evidence-row"><div><span className="live-source-label">Observed headings</span><div className="heading-pills">{(liveAnalysis.headings.length ? liveAnalysis.headings : ["No H1–H3 headings exposed"]).slice(0, 6).map((heading) => <span key={heading}>{heading}</span>)}</div></div><div><span className="live-source-label">Observed pricing</span><div className="heading-pills">{(liveAnalysis.prices.length ? liveAnalysis.prices : ["No public price pattern found"]).map((price) => <span key={price}>{price}</span>)}</div></div></div></section>}

        {liveAnalysis && <section className="panel ai-brief-panel"><div className="panel-heading"><div><span className="section-number">AI</span><h3>What changed in your market?</h3></div><span className={`brief-mode ${marketBrief?.aiGenerated ? "brief-mode-ai" : ""}`}>{briefLoading ? "Synthesizing…" : marketBrief?.aiGenerated ? "Standard model" : "Grounded demo"}</span></div>{briefLoading && <div className="brief-loading"><span className="pulse-dot" /> Connecting observed claims into a decision-ready brief.</div>}{marketBrief && <><div className="brief-hero"><h4>{marketBrief.headline}</h4><p>{marketBrief.summary}</p></div><div className="signal-grid">{marketBrief.signals.map((signal) => <article className="signal-card" key={signal.label}><div className="signal-card-label">{signal.label}</div><p>{signal.text}</p><strong>Why it matters</strong><span>{signal.implication}</span><div className="signal-sources">{signal.claimIds.map((claimId) => { const claim = marketBrief.claims.find((item) => item.id === claimId); return claim ? <a href={claim.sourceUrl} target="_blank" rel="noreferrer" key={claim.id} title={claim.text}>Source {marketBrief.claims.indexOf(claim) + 1} ↗</a> : null; })}</div></article>)}</div><div className="brief-footer"><div><span className="live-source-label">Next evidence to collect</span><ul>{marketBrief.nextChecks.map((check) => <li key={check}>{check}</li>)}</ul></div><div className="brief-ledger"><span className="live-source-label">Evidence ledger</span><strong>{marketBrief.claims.length} grounded claims</strong><span>Every insight above resolves to a public source.</span></div></div></>}</section>}

        {liveAnalysis && <div className="report-grid two-col">
          <section className="panel position-panel"><div className="panel-heading"><div><span className="section-number">01</span><h3>Observed market surface</h3></div><EvidenceTag type="Observed" /></div><p className="panel-intro">This is a source profile, not a market score. The scan found a public title, description, language, page structure, pricing patterns, and linked profiles for {liveAnalysis.domain}.</p><div className="position-bars"><div><span>Headings</span><div className="bar-track"><i style={{ width: `${Math.min(100, liveAnalysis.headings.length * 12)}%` }} /></div><b>{liveAnalysis.headings.length}</b></div><div><span>Prices</span><div className="bar-track coral-bar"><i style={{ width: `${Math.min(100, liveAnalysis.prices.length * 20)}%` }} /></div><b>{liveAnalysis.prices.length}</b></div><div><span>Social</span><div className="bar-track blue-bar"><i style={{ width: `${Math.min(100, liveAnalysis.socialLinks.length * 20)}%` }} /></div><b>{liveAnalysis.socialLinks.length}</b></div><div><span>Links</span><div className="bar-track violet-bar"><i style={{ width: `${Math.min(100, liveAnalysis.internalLinks.length * 5)}%` }} /></div><b>{liveAnalysis.internalLinks.length}</b></div></div><div className="panel-footer"><Confidence value="High" /><span>Counts are derived from the public page fetched above.</span></div></section>
          <section className="panel moves-panel"><div className="panel-heading"><div><span className="section-number">02</span><h3>Recommended collection moves</h3></div><EvidenceTag type="Recommended" /></div><ol className="move-list">{getCollectionMoves(liveAnalysis).map((move, index) => <li key={move.title}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{move.title}</strong><p>{move.body}</p></div></li>)}</ol><button className="text-button" onClick={() => showToast("These recommendations are derived from the observed coverage gaps.")}>Why this is next <span>→</span></button></section>
        </div>}

{comparisonResults.length > 1 && <section className="panel live-comparison-panel"><div className="panel-heading"><div><span className="section-number">LIVE</span><h3>Public comparison</h3></div><EvidenceTag type="Observed" /></div><p className="panel-intro">These comparison domains were fetched from their public homepages. Each card links back to the source that was observed.</p><div className="live-compare-grid">{comparisonResults.map((result) => <article className="live-compare-card" key={result.domain}><div className="live-compare-heading"><span className="competitor-avatar blue">{getCompanyName(result.domain).charAt(0)}</span><div><strong>{getCompanyName(result.domain)}</strong><span>{result.domain}</span></div><EvidenceTag type="Observed" /></div><p>{result.description}</p><div className="live-compare-facts"><span><b>{result.prices.length}</b> pricing signals</span><span><b>{result.headings.length}</b> headings</span><span><b>{result.socialLinks.length}</b> social links</span></div><a href={result.sourceUrl} target="_blank" rel="noreferrer">Open observed source ↗</a></article>)}</div><div className="panel-footer"><Confidence value="High" /><span>Observed from public HTML; no market score is implied.</span></div></section>}

        <div className="report-grid two-col lower-grid">
{comparisonResults.length > 1 && <section className="panel pricing-panel live-pricing-panel"><div className="panel-heading"><div><span className="section-number">LIVE</span><h3>Public pricing signals</h3></div><EvidenceTag type="Observed" /></div><div className="table-wrap"><table><thead><tr><th>Observed signal</th>{comparisonResults.map((result) => <th key={result.domain}>{getCompanyName(result.domain)}</th>)}</tr></thead><tbody><tr><td>Price patterns</td>{comparisonResults.map((result) => <td key={result.domain} className={result === comparisonResults[0] ? "you-cell" : ""}>{result.prices.length ? result.prices.join(", ") : "None found"}</td>)}</tr><tr><td>Language</td>{comparisonResults.map((result) => <td key={result.domain}>{result.language}</td>)}</tr><tr><td>Social presence</td>{comparisonResults.map((result) => <td key={result.domain}>{result.socialLinks.length ? `${result.socialLinks.length} public links` : "None exposed"}</td>)}</tr></tbody></table></div><div className="panel-footer"><span className="source-chip">Live homepage evidence</span><span>Observed on submission</span></div></section>}
          <section className="panel ads-panel"><div className="panel-heading"><div><span className="section-number">05</span><h3>Public-source coverage</h3></div><EvidenceTag type="Observed" /></div><p className="panel-intro">This scan did not collect ad-library or social-feed records. That is a coverage state, not a zero signal.</p><div className="coverage-list"><div><strong>Website</strong><span className="coverage-state coverage-live">Collected now</span><p>{liveAnalysis ? liveAnalysis.sourceUrl : "No source submitted"}</p></div><div><strong>Pricing pages</strong><span className="coverage-state">Next adapter</span><p>Not collected in this homepage scan.</p></div><div><strong>Meta · Google · TikTok</strong><span className="coverage-state">Not collected</span><p>No ad volume or spend estimate is shown.</p></div><div><strong>Historical snapshots</strong><span className="coverage-state">Next adapter</span><p>Nothing is called a change until a second dated observation exists.</p></div></div></section>
        </div>

        {comparisonResults.length > 0 && <section className="evidence-strip live-evidence-strip" id="method"><div><span className="section-number">LIVE</span><strong>Observed sources</strong><span className="evidence-sub">One trail per scanned domain.</span></div><div className="evidence-items">{comparisonResults.map((result) => <div className="evidence-item" key={result.domain}><EvidenceTag type="Observed" /><strong>{result.domain}</strong><span>{new Date(result.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><Confidence value="High" /></div>)}</div></section>}
      </section>

      <section className="method-section shell"><div className="method-copy"><div className="eyebrow">The signal, not the spectacle</div><h2>See what we know.<br /><em>See how we know it.</em></h2><p>Market Signal separates public observations from AI inferences, estimates, and recommendations. That is how a fast answer becomes a useful one.</p></div><div className="method-steps"><div><span>01</span><strong>Collect</strong><p>Public websites, pricing pages, search landscapes, and ad libraries.</p></div><div><span>02</span><strong>Connect</strong><p>Normalize evidence across regions, channels, and competitor patterns.</p></div><div><span>03</span><strong>Explain</strong><p>Turn the signal into a decision your team can act on this week.</p></div></div></section>

      <footer className="site-footer shell"><a className="brand" href="#top"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></a><span>Public intelligence, made useful.</span><span>© 2026 Market Signal</span></footer>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
