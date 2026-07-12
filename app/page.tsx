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

type LiveAnalysisError = { ok: false; live: false; domain: string; error: string; fetchedAt: string };
type BriefClaim = { id: string; text: string; sourceUrl: string; observedAt: string; claimType: ClaimType; confidence: "High" | "Medium" | "Low" };
type MarketSignal = { label: string; text: string; implication: string; claimIds: string[] };
type MarketBrief = { ok: true; headline: string; headlineClaimIds: string[]; summary: string; summaryClaimIds: string[]; signals: MarketSignal[]; nextChecks: string[]; claims: BriefClaim[]; model: string; generatedAt: string; aiGenerated: boolean };

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

export default function Home() {
  const [domain, setDomain] = useState("");
  const [reportDomain, setReportDomain] = useState<string | null>(null);
  const [liveAnalysis, setLiveAnalysis] = useState<LiveAnalysis | null>(null);
  const [comparisonResults, setComparisonResults] = useState<LiveAnalysis[]>([]);
  const [comparisonDomains, setComparisonDomains] = useState<string[]>([]);
  const [marketBrief, setMarketBrief] = useState<MarketBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [toast, setToast] = useState("");

  const companyName = useMemo(() => getCompanyName(reportDomain ?? domain), [domain, reportDomain]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const requestedDomains = [cleanDomain, ...comparisonDomains.map((value) => value.replace(/^https?:\/\//, "").replace(/\/$/, "")).filter(Boolean)];
    setIsAnalyzing(true);
    setAnalysisError("");
    setLiveAnalysis(null);
    setMarketBrief(null);
    setReportDomain(null);
    try {
      const params = new URLSearchParams();
      requestedDomains.forEach((value) => params.append("domain", value));
      const response = await fetch(`/api/analyze?${params.toString()}`);
      const payload = await response.json() as LiveAnalysis | LiveAnalysisError | { ok: true; live: true; results: Array<LiveAnalysis | LiveAnalysisError> };
      const results = "results" in payload ? payload.results : [payload];
      const successful = results.filter((result): result is LiveAnalysis => result.ok && result.live);
      const failed = results.filter((result): result is LiveAnalysisError => !result.ok);
      const primaryHost = getDomainHost(cleanDomain);
      const primaryResult = successful.find((result) => result.domain === primaryHost);
      if (!primaryResult) throw new Error(`Primary domain ${cleanDomain} could not be read: ${failed.find((result) => result.domain === primaryHost)?.error || "no live result was returned"}`);
      setComparisonResults(successful);
      setLiveAnalysis(primaryResult);
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
      const failedComparisonDomains = failed.filter((result) => result.domain !== primaryHost);
      if (failedComparisonDomains.length) setAnalysisError(`${failedComparisonDomains.length} comparison domain${failedComparisonDomains.length === 1 ? "" : "s"} could not be read: ${failedComparisonDomains.map((result) => result.domain).join(", ")}. Successful sources are still shown.`);
      window.setTimeout(() => document.getElementById("report")?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "Unable to analyze this domain.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function addComparisonDomain() {
    if (comparisonDomains.length < 3) setComparisonDomains([...comparisonDomains, ""]);
  }

  function updateComparisonDomain(index: number, value: string) {
    setComparisonDomains(comparisonDomains.map((domainValue, domainIndex) => domainIndex === index ? value : domainValue));
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
            <label htmlFor="domain">Your company domain</label>
            <div className="input-row">
              <div className="domain-input"><span>https://</span><input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="yourcompany.com" /></div>
              <button className="primary-button" type="submit" disabled={isAnalyzing}>{isAnalyzing ? "Reading public site…" : "Analyze market"} <span>{isAnalyzing ? "·" : "→"}</span></button>
            </div>
            <div className="comparison-inputs"><div className="comparison-label"><span>Optional comparison domains</span><small>Up to 3 · public pages only</small></div>{comparisonDomains.map((comparisonDomain, index) => <div className="comparison-input-row" key={`comparison-${index}`}><span>{index + 1}</span><input value={comparisonDomain} onChange={(event) => updateComparisonDomain(index, event.target.value)} placeholder="competitor.com" aria-label={`Comparison domain ${index + 1}`} /></div>)}{comparisonDomains.length < 3 && <button className="add-comparison" type="button" onClick={addComparisonDomain}>+ Add a comparison domain</button>}</div>
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
          <div><div className="eyebrow"><span className="pulse-dot" /> Competitive landscape report</div><h2>{liveAnalysis ? `${companyName} has a live public-source profile.` : "A report that starts with one URL."}</h2><p>{liveAnalysis ? `Observed facts below were fetched from ${liveAnalysis.sourceUrl}. Comparisons appear only when their domains are separately scanned.` : "Submit a domain to collect public evidence. No market result is shown before the scan completes."}</p></div>
          <div className="report-actions"><button className="secondary-button" onClick={() => showToast("Export is ready when live evidence is connected.")}>Export report <span>↓</span></button><button className="secondary-button" onClick={() => showToast("Weekly monitoring is available in the next release.")}>Set cadence <span>⌄</span></button></div>
        </div>

        <div className="metric-grid">
          <div className="metric-card"><span className="metric-label">Public source</span><strong>{liveAnalysis ? "LIVE" : "—"}</strong><div className="metric-trend positive">{liveAnalysis ? "Fetched on submission" : "Waiting for scan"}</div></div>
          <div className="metric-card"><span className="metric-label">Headings observed</span><strong>{liveAnalysis ? liveAnalysis.headings.length : "—"}</strong><div className="metric-trend">{liveAnalysis ? "H1–H3 on the scanned page" : "No source yet"}</div></div>
          <div className="metric-card"><span className="metric-label">Price patterns</span><strong>{liveAnalysis ? liveAnalysis.prices.length : "—"}</strong><div className="metric-trend">{liveAnalysis ? "Public HTML only" : "No source yet"}</div></div>
          <div className="metric-card accent-card"><span className="metric-label">Next collection step</span><strong>{liveAnalysis ? (liveAnalysis.prices.length ? "Verify" : "Collect") : "—"}</strong><div className="metric-trend">{liveAnalysis ? "Pricing surface" : "Waiting for scan"}</div></div>
        </div>

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
