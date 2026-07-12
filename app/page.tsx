"use client";

import { FormEvent, useMemo, useState } from "react";

type ClaimType = "Observed" | "Inferred" | "Estimated" | "Recommended";

type Evidence = {
  claimType: ClaimType;
  source: string;
  date: string;
  confidence: "High" | "Medium" | "Low";
};

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

function Confidence({ value }: { value: string }) {
  return <span className={`confidence confidence-${value.toLowerCase()}`}><span />{value} confidence</span>;
}

function EvidenceTag({ type }: { type: ClaimType }) {
  return <span className={`evidence-tag evidence-${type.toLowerCase()}`}>{type}</span>;
}

export default function Home() {
  const [domain, setDomain] = useState("acmecommerce.com");
  const [reportDomain, setReportDomain] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const companyName = useMemo(() => getCompanyName(reportDomain ?? domain), [domain, reportDomain]);

  function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReportDomain(domain.replace(/^https?:\/\//, "").replace(/\/$/, ""));
    window.setTimeout(() => document.getElementById("report")?.scrollIntoView({ behavior: "smooth" }), 50);
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
              <button className="primary-button" type="submit">Analyze market <span>→</span></button>
            </div>
            <div className="form-note"><span className="lock">◇</span> One free report · no account required · public signals only</div>
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
          <div><div className="eyebrow"><span className="pulse-dot" /> Competitive landscape report</div><h2>{reportDomain ? `${companyName} is playing in a busy, winnable market.` : "A report that starts with one URL."}</h2><p>{reportDomain ? `Generated from public market signals for ${reportDomain}. The strongest opening: differentiate on speed-to-value, not feature count.` : "See the complete picture your team usually assembles across tabs, spreadsheets, and half-remembered screenshots."}</p></div>
          <div className="report-actions"><button className="secondary-button" onClick={() => showToast("Export is ready when live evidence is connected.")}>Export report <span>↓</span></button><button className="secondary-button" onClick={() => showToast("Weekly monitoring is available in the next release.")}>Set cadence <span>⌄</span></button></div>
        </div>

        <div className="metric-grid">
          <div className="metric-card"><span className="metric-label">Market position</span><strong>84<span>/100</span></strong><div className="metric-trend positive">↑ 6 pts vs. last read</div></div>
          <div className="metric-card"><span className="metric-label">Competitors surfaced</span><strong>11</strong><div className="metric-trend">Across 3 regional clusters</div></div>
          <div className="metric-card"><span className="metric-label">Observed signals</span><strong>68</strong><div className="metric-trend">31 public sources checked</div></div>
          <div className="metric-card accent-card"><span className="metric-label">Next best move</span><strong>Own “easy”</strong><div className="metric-trend">The clearest open position</div></div>
        </div>

        <div className="report-grid two-col">
          <section className="panel position-panel"><div className="panel-heading"><div><span className="section-number">01</span><h3>Market position</h3></div><EvidenceTag type="Inferred" /></div><p className="panel-intro">You are visible enough to compete, but your message is being filed next to “more features.” The white space is a faster path from first visit to first win.</p><div className="position-bars"><div><span>You</span><div className="bar-track"><i style={{ width: "72%" }} /></div><b>72</b></div><div><span>Northstar</span><div className="bar-track coral-bar"><i style={{ width: "82%" }} /></div><b>82</b></div><div><span>Brightcart</span><div className="bar-track blue-bar"><i style={{ width: "76%" }} /></div><b>76</b></div><div><span>Shopline</span><div className="bar-track violet-bar"><i style={{ width: "69%" }} /></div><b>69</b></div></div><div className="panel-footer"><Confidence value="High" /><span>Based on search visibility, category language, and public positioning.</span></div></section>
          <section className="panel moves-panel"><div className="panel-heading"><div><span className="section-number">02</span><h3>Recommended moves</h3></div><EvidenceTag type="Recommended" /></div><ol className="move-list"><li><span>01</span><div><strong>Make “easy” a product promise.</strong><p>Three competitors lead with power. None own the low-friction outcome.</p></div></li><li><span>02</span><div><strong>Defend the $39–$49 buying moment.</strong><p>Your current entry price sits in the highest comparison density.</p></div></li><li><span>03</span><div><strong>Turn proof into a repeatable ad asset.</strong><p>Social proof is present in competitor creative, but not yet saturated.</p></div></li></ol><button className="text-button" onClick={() => showToast("Recommendation detail will open with live evidence.")}>See the reasoning <span>→</span></button></section>
        </div>

        <section className="panel competitor-panel"><div className="panel-heading"><div><span className="section-number">03</span><h3>Competitive set</h3></div><span className="panel-note">Automatically inferred · 11 total</span></div><div className="competitor-list">{competitors.map((competitor) => <div className="competitor-row" key={competitor.name}><span className={`competitor-avatar ${competitor.color}`}>{competitor.name.charAt(0)}</span><div className="competitor-name"><strong>{competitor.name}</strong><span>{competitor.domain}</span></div><div className="competitor-signal"><span>{competitor.signal}</span><div className="mini-track"><i className={competitor.color} style={{ width: `${competitor.score}%` }} /></div></div><strong className="competitor-score">{competitor.score}</strong><button className="row-action" aria-label={`View ${competitor.name} evidence`} onClick={() => showToast(`${competitor.name} evidence will open in the next release.`)}>↗</button></div>)}</div><div className="panel-footer"><Confidence value="High" /><span>Discovery combines category language, search overlap, pricing proximity, and audience signals.</span><button className="text-button">View all 11 <span>→</span></button></div></section>

        <div className="report-grid two-col lower-grid">
          <section className="panel pricing-panel"><div className="panel-heading"><div><span className="section-number">04</span><h3>Products & pricing</h3></div><EvidenceTag type="Observed" /></div><div className="table-wrap"><table><thead><tr><th>Signal</th><th>You</th><th>Northstar</th><th>Brightcart</th></tr></thead><tbody>{products.map((row) => <tr key={row.label}><td>{row.label}</td><td className="you-cell">{row.company}</td><td>{row.northstar}</td><td>{row.brightcart}</td></tr>)}</tbody></table></div><div className="panel-footer"><span className="source-chip">Homepage · Pricing pages · 12 sources</span><span>Observed today</span></div></section>
          <section className="panel ads-panel"><div className="panel-heading"><div><span className="section-number">05</span><h3>Public ad signals</h3></div><EvidenceTag type="Estimated" /></div><div className="ad-list">{adSignals.map((signal) => <div className="ad-row" key={signal.channel}><span className={`channel-icon ${signal.color}`}>{signal.glyph}</span><div className="ad-copy"><div><strong>{signal.channel}</strong><span>{signal.ads}</span></div><p>{signal.copy}</p></div><div className="ad-range"><strong>{signal.range}</strong><Confidence value={signal.confidence} /></div></div>)}</div><div className="estimate-note">Spend ranges are estimates from public creative volume, placement, and reach signals — never exact spend.</div></section>
        </div>

        <section className="evidence-strip" id="method"><div><span className="section-number">06</span><strong>Evidence ledger</strong><span className="evidence-sub">Everything has a trail.</span></div><div className="evidence-items">{evidence.map((item) => <div className="evidence-item" key={item.source}><EvidenceTag type={item.claimType} /><strong>{item.source}</strong><span>{item.date}</span><Confidence value={item.confidence} /></div>)}</div></section>
      </section>

      <section className="method-section shell"><div className="method-copy"><div className="eyebrow">The signal, not the spectacle</div><h2>See what we know.<br /><em>See how we know it.</em></h2><p>Market Signal separates public observations from AI inferences, estimates, and recommendations. That is how a fast answer becomes a useful one.</p></div><div className="method-steps"><div><span>01</span><strong>Collect</strong><p>Public websites, pricing pages, search landscapes, and ad libraries.</p></div><div><span>02</span><strong>Connect</strong><p>Normalize evidence across regions, channels, and competitor patterns.</p></div><div><span>03</span><strong>Explain</strong><p>Turn the signal into a decision your team can act on this week.</p></div></div></section>

      <footer className="site-footer shell"><a className="brand" href="#top"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></a><span>Public intelligence, made useful.</span><span>© 2026 Market Signal</span></footer>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
