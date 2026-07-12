"use client";

import { FormEvent, useMemo, useState } from "react";

type ClaimType = "Observed" | "Inferred" | "Estimated" | "Recommended";

type Evidence = {
  claimType: ClaimType;
  source: string;
  date: string;
  confidence: "High" | "Medium" | "Low";
};

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

const competitors = [
  { name: "Northstar", domain: "northstar.co", score: 82, color: "coral", signal: "Messaging overlap" },
  { name: "Brightcart", domain: "brightcart.io", score: 76, color: "blue", signal: "Price pressure" },
  { name: "Shopline", domain: "shopline.com", score: 69, color: "violet", signal: "Audience overlap" },
];

const products = [
  { label: "Starter plan", company: "$39 / mo", northstar: "$49 / mo", brightcart: "$29 / mo" },
  { label: "Free trial", company: "14 days", northstar: "14 days", brightcart: "7 days" },
  { label: "Multi-store", company: "Included", northstar: "Pro only", brightcart: "Included" },
  { label: "AI merchandising", company: "Beta", northstar: "Included", brightcart: "—" },
];

const adSignals = [
  { channel: "Meta", glyph: "M", color: "meta", ads: "18 active creatives", range: "$8k–$14k / mo", confidence: "Medium", copy: "Leaning on social proof and rapid setup." },
  { channel: "Google", glyph: "G", color: "google", ads: "11 search themes", range: "$5k–$9k / mo", confidence: "High", copy: "Defending high-intent category keywords." },
  { channel: "TikTok", glyph: "T", color: "tiktok", ads: "7 active creatives", range: "$2k–$6k / mo", confidence: "Low", copy: "Testing creator-led problem / solution hooks." },
];

const evidence: Evidence[] = [
  { claimType: "Inferred", source: "Search landscape", date: "2h ago", confidence: "High" },
  { claimType: "Observed", source: "Meta Ad Library", date: "Today", confidence: "High" },
  { claimType: "Estimated", source: "Channel signal model", date: "Today", confidence: "Medium" },
];

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

function Confidence({ value }: { value: string }) {
  return <span className={`confidence confidence-${value.toLowerCase()}`}><span />{value} confidence</span>;
}

function EvidenceTag({ type }: { type: ClaimType }) {
  return <span className={`evidence-tag evidence-${type.toLowerCase()}`}>{type}</span>;
}

export default function Home() {
  const [domain, setDomain] = useState("acmecommerce.com");
  const [reportDomain, setReportDomain] = useState<string | null>(null);
  const [liveAnalysis, setLiveAnalysis] = useState<LiveAnalysis | null>(null);
  const [comparisonResults, setComparisonResults] = useState<LiveAnalysis[]>([]);
  const [comparisonDomains, setComparisonDomains] = useState<string[]>([]);
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
          <a href="#report">Sample report</a>
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
        <div className="hero-preview" aria-label="Preview of a Market Signal report">
          <div className="preview-top"><span className="window-dot coral" /><span className="window-dot amber" /><span className="window-dot green" /><span className="preview-label">MARKET / LIVE SIGNALS</span><span className="preview-time">updated 2h ago</span></div>
          <div className="preview-body">
            <div className="preview-kicker">YOUR MARKET MAP</div>
            <div className="preview-title">A sharper read on <strong>where to play next.</strong></div>
            <div className="preview-chart"><div className="chart-axis"><span>High visibility</span><span>Low visibility</span></div><div className="chart-grid"><span className="chart-dot dot-you" /><span className="chart-dot dot-one" /><span className="chart-dot dot-two" /><span className="chart-dot dot-three" /><span className="chart-label you-label">You</span><span className="chart-label one-label">Northstar</span><span className="chart-label two-label">Brightcart</span><span className="chart-label three-label">Shopline</span></div></div>
            <div className="preview-foot"><span><b>11</b> competitors found</span><span><b>68</b> sources checked</span><span><b>84%</b> signal confidence</span></div>
          </div>
        </div>
      </section>

      <section className={`report-section shell ${reportDomain ? "report-visible" : ""}`} id="report" aria-live="polite">
        <div className="report-header">
          <div><div className="eyebrow"><span className="pulse-dot" /> Competitive landscape report</div><h2>{liveAnalysis ? `${companyName} now has a live source profile.` : reportDomain ? `${companyName} is playing in a busy, winnable market.` : "A report that starts with one URL."}</h2><p>{liveAnalysis ? `Live facts below were fetched from ${liveAnalysis.sourceUrl}. Competitor and ad panels remain illustrative until their public-source adapters are connected.` : reportDomain ? `Generated from public market signals for ${reportDomain}. The strongest opening: differentiate on speed-to-value, not feature count.` : "See the complete picture your team usually assembles across tabs, spreadsheets, and half-remembered screenshots."}</p></div>
          <div className="report-actions"><button className="secondary-button" onClick={() => showToast("Export is ready when live evidence is connected.")}>Export report <span>↓</span></button><button className="secondary-button" onClick={() => showToast("Weekly monitoring is available in the next release.")}>Set cadence <span>⌄</span></button></div>
        </div>

        <div className="metric-grid">
          <div className="metric-card"><span className="metric-label">Live source profile</span><strong>{liveAnalysis ? Math.min(99, 40 + (liveAnalysis.title ? 15 : 0) + (liveAnalysis.description ? 15 : 0) + (liveAnalysis.headings.length ? 15 : 0) + (liveAnalysis.prices.length ? 10 : 0) + (liveAnalysis.socialLinks.length ? 5 : 0)) : "84"}<span>/100</span></strong><div className="metric-trend positive">{liveAnalysis ? "Based on public HTML signals" : "Demo profile completeness"}</div></div>
          <div className="metric-card"><span className="metric-label">Public headings found</span><strong>{liveAnalysis ? liveAnalysis.headings.length : "11"}</strong><div className="metric-trend">{liveAnalysis ? "H1–H3 signals observed" : "Illustrative competitor set"}</div></div>
          <div className="metric-card"><span className="metric-label">Pricing signals</span><strong>{liveAnalysis ? liveAnalysis.prices.length : "68"}</strong><div className="metric-trend">{liveAnalysis ? "Currency patterns observed" : "Illustrative source count"}</div></div>
          <div className="metric-card accent-card"><span className="metric-label">Next best move</span><strong>Own “easy”</strong><div className="metric-trend">The clearest open position</div></div>
        </div>

        {liveAnalysis && <section className="panel live-source-panel"><div className="panel-heading"><div><span className="section-number">LIVE</span><h3>Public source scan</h3></div><EvidenceTag type="Observed" /></div><div className="live-source-grid"><div className="live-source-main"><span className="live-source-label">Page title</span><strong>{liveAnalysis.title}</strong><p>{liveAnalysis.description}</p><a href={liveAnalysis.sourceUrl} target="_blank" rel="noreferrer">Open observed source ↗</a></div><div className="live-fact"><span className="live-source-label">Language</span><strong>{liveAnalysis.language}</strong><span>{liveAnalysis.region}</span></div><div className="live-fact"><span className="live-source-label">Page words</span><strong>{liveAnalysis.wordCount.toLocaleString()}</strong><span>{liveAnalysis.truncated ? "First 1.5 MB scanned" : "Public HTML scanned"}</span></div><div className="live-fact"><span className="live-source-label">Social links</span><strong>{liveAnalysis.socialLinks.length}</strong><span>{liveAnalysis.socialLinks.length ? "Public profiles linked" : "None exposed"}</span></div></div><div className="live-evidence-row"><div><span className="live-source-label">Observed headings</span><div className="heading-pills">{(liveAnalysis.headings.length ? liveAnalysis.headings : ["No H1–H3 headings exposed"]).slice(0, 6).map((heading) => <span key={heading}>{heading}</span>)}</div></div><div><span className="live-source-label">Observed pricing</span><div className="heading-pills">{(liveAnalysis.prices.length ? liveAnalysis.prices : ["No public price pattern found"]).map((price) => <span key={price}>{price}</span>)}</div></div></div></section>}

        <div className="report-grid two-col">
          <section className="panel position-panel"><div className="panel-heading"><div><span className="section-number">01</span><h3>Market position</h3></div><EvidenceTag type="Inferred" /></div><p className="panel-intro">You are visible enough to compete, but your message is being filed next to “more features.” The white space is a faster path from first visit to first win.</p><div className="position-bars"><div><span>You</span><div className="bar-track"><i style={{ width: "72%" }} /></div><b>72</b></div><div><span>Northstar</span><div className="bar-track coral-bar"><i style={{ width: "82%" }} /></div><b>82</b></div><div><span>Brightcart</span><div className="bar-track blue-bar"><i style={{ width: "76%" }} /></div><b>76</b></div><div><span>Shopline</span><div className="bar-track violet-bar"><i style={{ width: "69%" }} /></div><b>69</b></div></div><div className="panel-footer"><Confidence value="High" /><span>Based on search visibility, category language, and public positioning.</span></div></section>
          <section className="panel moves-panel"><div className="panel-heading"><div><span className="section-number">02</span><h3>Recommended moves</h3></div><EvidenceTag type="Recommended" /></div><ol className="move-list"><li><span>01</span><div><strong>Make “easy” a product promise.</strong><p>Three competitors lead with power. None own the low-friction outcome.</p></div></li><li><span>02</span><div><strong>Defend the $39–$49 buying moment.</strong><p>Your current entry price sits in the highest comparison density.</p></div></li><li><span>03</span><div><strong>Turn proof into a repeatable ad asset.</strong><p>Social proof is present in competitor creative, but not yet saturated.</p></div></li></ol><button className="text-button" onClick={() => showToast("Recommendation detail will open with live evidence.")}>See the reasoning <span>→</span></button></section>
        </div>

        <section className={`panel competitor-panel ${comparisonResults.length > 1 ? "fixture-only" : ""}`}><div className="panel-heading"><div><span className="section-number">03</span><h3>Competitive set</h3></div><span className="panel-note">Automatically inferred · 11 total</span></div><div className="competitor-list">{competitors.map((competitor) => <div className="competitor-row" key={competitor.name}><span className={`competitor-avatar ${competitor.color}`}>{competitor.name.charAt(0)}</span><div className="competitor-name"><strong>{competitor.name}</strong><span>{competitor.domain}</span></div><div className="competitor-signal"><span>{competitor.signal}</span><div className="mini-track"><i className={competitor.color} style={{ width: `${competitor.score}%` }} /></div></div><strong className="competitor-score">{competitor.score}</strong><button className="row-action" aria-label={`View ${competitor.name} evidence`} onClick={() => showToast(`${competitor.name} evidence will open in the next release.`)}>↗</button></div>)}</div><div className="panel-footer"><Confidence value="High" /><span>Discovery combines category language, search overlap, pricing proximity, and audience signals.</span><button className="text-button">View all 11 <span>→</span></button></div></section>
{comparisonResults.length > 1 && <section className="panel live-comparison-panel"><div className="panel-heading"><div><span className="section-number">LIVE</span><h3>Public comparison</h3></div><EvidenceTag type="Observed" /></div><p className="panel-intro">These comparison domains were fetched from their public homepages. Each card links back to the source that was observed.</p><div className="live-compare-grid">{comparisonResults.map((result) => <article className="live-compare-card" key={result.domain}><div className="live-compare-heading"><span className="competitor-avatar blue">{getCompanyName(result.domain).charAt(0)}</span><div><strong>{getCompanyName(result.domain)}</strong><span>{result.domain}</span></div><EvidenceTag type="Observed" /></div><p>{result.description}</p><div className="live-compare-facts"><span><b>{result.prices.length}</b> pricing signals</span><span><b>{result.headings.length}</b> headings</span><span><b>{result.socialLinks.length}</b> social links</span></div><a href={result.sourceUrl} target="_blank" rel="noreferrer">Open observed source ↗</a></article>)}</div><div className="panel-footer"><Confidence value="High" /><span>Observed from public HTML; no market score is implied.</span></div></section>}

        <div className="report-grid two-col lower-grid">
          <section className={`panel pricing-panel ${comparisonResults.length > 1 ? "fixture-only" : ""}`}><div className="panel-heading"><div><span className="section-number">04</span><h3>Products & pricing</h3></div><EvidenceTag type="Observed" /></div><div className="table-wrap"><table><thead><tr><th>Signal</th><th>You</th><th>Northstar</th><th>Brightcart</th></tr></thead><tbody>{products.map((row) => <tr key={row.label}><td>{row.label}</td><td className="you-cell">{row.company}</td><td>{row.northstar}</td><td>{row.brightcart}</td></tr>)}</tbody></table></div><div className="panel-footer"><span className="source-chip">Homepage · Pricing pages · 12 sources</span><span>Observed today</span></div></section>
{comparisonResults.length > 1 && <section className="panel pricing-panel live-pricing-panel"><div className="panel-heading"><div><span className="section-number">LIVE</span><h3>Public pricing signals</h3></div><EvidenceTag type="Observed" /></div><div className="table-wrap"><table><thead><tr><th>Observed signal</th>{comparisonResults.map((result) => <th key={result.domain}>{getCompanyName(result.domain)}</th>)}</tr></thead><tbody><tr><td>Price patterns</td>{comparisonResults.map((result) => <td key={result.domain} className={result === comparisonResults[0] ? "you-cell" : ""}>{result.prices.length ? result.prices.join(", ") : "None found"}</td>)}</tr><tr><td>Language</td>{comparisonResults.map((result) => <td key={result.domain}>{result.language}</td>)}</tr><tr><td>Social presence</td>{comparisonResults.map((result) => <td key={result.domain}>{result.socialLinks.length ? `${result.socialLinks.length} public links` : "None exposed"}</td>)}</tr></tbody></table></div><div className="panel-footer"><span className="source-chip">Live homepage evidence</span><span>Observed on submission</span></div></section>}
          <section className="panel ads-panel"><div className="panel-heading"><div><span className="section-number">05</span><h3>Public ad signals</h3></div><EvidenceTag type="Estimated" /></div><div className="ad-list">{adSignals.map((signal) => <div className="ad-row" key={signal.channel}><span className={`channel-icon ${signal.color}`}>{signal.glyph}</span><div className="ad-copy"><div><strong>{signal.channel}</strong><span>{signal.ads}</span></div><p>{signal.copy}</p></div><div className="ad-range"><strong>{signal.range}</strong><Confidence value={signal.confidence} /></div></div>)}</div><div className="estimate-note">Spend ranges are estimates from public creative volume, placement, and reach signals — never exact spend.</div></section>
        </div>

        <section className={`evidence-strip ${comparisonResults.length > 1 ? "fixture-only" : ""}`} id={comparisonResults.length > 1 ? undefined : "method"}><div><span className="section-number">06</span><strong>Evidence ledger</strong><span className="evidence-sub">Everything has a trail.</span></div><div className="evidence-items">{evidence.map((item) => <div className="evidence-item" key={item.source}><EvidenceTag type={item.claimType} /><strong>{item.source}</strong><span>{item.date}</span><Confidence value={item.confidence} /></div>)}</div></section>
{comparisonResults.length > 1 && <section className="evidence-strip live-evidence-strip" id="method"><div><span className="section-number">LIVE</span><strong>Observed sources</strong><span className="evidence-sub">One trail per domain.</span></div><div className="evidence-items">{comparisonResults.map((result) => <div className="evidence-item" key={result.domain}><EvidenceTag type="Observed" /><strong>{result.domain}</strong><span>{new Date(result.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><Confidence value="High" /></div>)}</div></section>}
      </section>

      <section className="method-section shell"><div className="method-copy"><div className="eyebrow">The signal, not the spectacle</div><h2>See what we know.<br /><em>See how we know it.</em></h2><p>Market Signal separates public observations from AI inferences, estimates, and recommendations. That is how a fast answer becomes a useful one.</p></div><div className="method-steps"><div><span>01</span><strong>Collect</strong><p>Public websites, pricing pages, search landscapes, and ad libraries.</p></div><div><span>02</span><strong>Connect</strong><p>Normalize evidence across regions, channels, and competitor patterns.</p></div><div><span>03</span><strong>Explain</strong><p>Turn the signal into a decision your team can act on this week.</p></div></div></section>

      <footer className="site-footer shell"><a className="brand" href="#top"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></a><span>Public intelligence, made useful.</span><span>© 2026 Market Signal</span></footer>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
