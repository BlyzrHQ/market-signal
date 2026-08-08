"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { SiteFooter } from "./components/site-footer";
import { postJson } from "./lib/json-response";

type Locale = "en" | "ar";
type ProofView = "dashboard" | "competitors" | "catalog";
type CreateReportResponse =
  | { ok: true; report: { publicId: string }; job: { dispatched: true; runId: string } }
  | { ok: false; error?: string; publicId?: string };

const REPORT_URL = "/reports/7fb305987e9a439abcbb352ee7302b26?view=products&layout=table";
const proofViews: ProofView[] = ["dashboard", "competitors", "catalog"];

const products = [
  { name: "Castania Mixed Kernels 450G", image: "https://myjam.co.uk/cdn/shop/products/2464.jpg?v=1643311164&width=320", yourPrice: "£18.24", rival: "bakkali.app", rivalPrice: "£14.99", signal: "Rival is £3.25 lower" },
  { name: "Okra 500g", image: "https://myjam.co.uk/cdn/shop/products/Okra500g.jpg?v=1653567962&width=320", yourPrice: "£7.10", rival: "24shopping.shop", rivalPrice: "£7.99", signal: "You are £0.89 lower" },
  { name: "Iceberg Lettuce Each", image: "https://myjam.co.uk/cdn/shop/products/iceberg-lettuce-500g.jpg?v=1643309665&width=320", yourPrice: "£1.95", rival: "bakkali.app", rivalPrice: "Public price", signal: "Same product found" },
];

function ProofShowcase({ ar }: { ar: boolean }) {
  const [view, setView] = useState<ProofView>("dashboard");

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setView((current) => proofViews[(proofViews.indexOf(current) + 1) % proofViews.length]), 5200);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="proof-section shell" id="proof">
      <header className="proof-heading">
        <div><span>{ar ? "دليل، وليس وعوداً" : "Proof, not promises"}</span><h2>{ar ? "شاهد التقرير قبل أن تنشئ تقريرك." : "See the work before you run it."}</h2></div>
        <div><p>{ar ? "بيانات حقيقية من تقرير MyJam العام: الكتالوج والمنافسون ومقارنات الأسعار." : "Real output from the public MyJam report: catalog coverage, competitors, and priced product matches."}</p><Link href={REPORT_URL}>{ar ? "افتح التقرير الكامل" : "Open the full report"} ↗</Link></div>
      </header>

      <div className="proof-browser">
        <div className="proof-browser-top"><span><i /><i /><i /></span><b>signal.blyzr.com / myjam.co.uk</b><em>{ar ? "تقرير حقيقي" : "REAL REPORT"}</em></div>
        <div className="proof-tabs" role="tablist" aria-label={ar ? "معاينات التقرير" : "Report previews"}>
          {proofViews.map((item, index) => <button key={item} role="tab" aria-selected={view === item} onClick={() => setView(item)}><span>0{index + 1}</span>{item === "dashboard" ? (ar ? "لوحة التحكم" : "Dashboard") : item === "competitors" ? (ar ? "المنافسون" : "Competitors") : (ar ? "كتالوج المنتجات" : "Product catalog")}</button>)}
        </div>

        <div className="proof-stage" key={view}>
          {view === "dashboard" && <div className="proof-dashboard">
            <aside><strong>Market Signal</strong><span className="active">Overview</span><span>Competitors <b>5</b></span><span>Products <b>282</b></span><span>Benchmark</span></aside>
            <div className="proof-canvas">
              <div className="proof-title"><div><span>MYJAM.CO.UK</span><h3>Your market, mapped.</h3></div><b>Agency · 1,000 products</b></div>
              <div className="proof-metrics"><article><span>PRODUCTS FOUND</span><strong>1,001</strong><small>Full catalog discovered</small></article><article><span>PRICED MATCHES</span><strong>282</strong><small>Every rival price verified</small></article><article><span>RIVALS MAPPED</span><strong>5</strong><small>Product-led discovery</small></article></div>
              <div className="proof-chart"><header><strong>Where the priced matches came from</strong><span>282 total</span></header>{[["24shopping.shop",140],["bakkali.app",101],["mymeatshop.co.uk",34],["Other verified",7]].map(([label, value]) => <div key={label}><span>{label}</span><i><b style={{ width: `${Number(value) / 1.4}%` }} /></i><strong>{value}</strong></div>)}</div>
            </div>
          </div>}

          {view === "competitors" && <div className="proof-competitors">
            <div className="competitor-map"><div className="market-core"><span>YOU</span><strong>myjam.co.uk</strong><small>1,001 products</small></div>{[{name:"24shopping",count:140,cls:"one"},{name:"Bakkali",count:101,cls:"two"},{name:"My Meat Shop",count:34,cls:"three"},{name:"Desii Basket",count:4,cls:"four"}].map((rival) => <div className={`rival-node ${rival.cls}`} key={rival.name}><span>{rival.count}</span><strong>{rival.name}</strong><small>priced matches</small></div>)}</div>
            <div className="competitor-ledger"><header><span>PRODUCT-LED DISCOVERY</span><strong>Who actually overlaps your shelf?</strong></header>{[["24shopping.shop","140","Highest product overlap"],["bakkali.app","101","Strong grocery overlap"],["mymeatshop.co.uk","34","Focused halal meat overlap"]].map(([domain,count,note], index) => <article key={domain}><i>0{index+1}</i><div><strong>{domain}</strong><span>{note}</span></div><b>{count}</b></article>)}</div>
          </div>}

          {view === "catalog" && <div className="proof-catalog"><header><div><span>PRODUCT × PRODUCT</span><strong>Only comparisons with a public rival price</strong></div><b>282 verified pairs</b></header><div className="catalog-table"><div className="catalog-head"><span>Your product</span><span>Your price</span><span>Closest rival</span><span>Rival price</span><span>Decision signal</span></div>{products.map((product) => <article key={product.name}><div className="catalog-product"><i style={{ backgroundImage: `url(${product.image})` }} /><strong>{product.name}</strong></div><b>{product.yourPrice}</b><span>{product.rival}</span><b>{product.rivalPrice}</b><em>{product.signal}</em></article>)}</div></div>}
        </div>
        <div className="proof-progress" aria-hidden="true"><i key={view} /></div>
      </div>
    </section>
  );
}

export default function Home() {
  const [locale, setLocale] = useState<Locale>("en");
  const [domain, setDomain] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const ar = locale === "ar";

  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = ar ? "rtl" : "ltr"; }, [ar, locale]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const primaryDomain = domain.trim();
    if (!primaryDomain) { setAnalysisError(ar ? "أدخل نطاق شركتك أو رابط موقعها." : "Enter your company domain or website URL."); return; }
    setIsAnalyzing(true); setAnalysisError("");
    try {
      const created = await postJson<CreateReportResponse>("/api/reports", { primaryDomain, locale }, "Persistent report creation");
      if (!created.ok) { const failed = created as Extract<CreateReportResponse, { ok: false }>; if (failed.publicId) window.location.assign(`/reports/${failed.publicId}/loading`); else throw new Error(failed.error || "The background report job could not be started."); return; }
      window.location.assign(`/reports/${created.report.publicId}/loading`);
    } catch (error) { setAnalysisError(error instanceof Error ? error.message : "The report could not be started."); setIsAnalyzing(false); }
  }

  return <main className="app-root landing-v2" lang={locale} dir={ar ? "rtl" : "ltr"}>
    <header className="site-header shell"><a className="brand" href="#top"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span><span className="beta-pill">BETA</span></a><nav className="header-nav"><a href="#proof">{ar ? "شاهد المنتج" : "Product proof"}</a><Link href="/how-it-works">{ar ? "كيف يعمل" : "How it works"}</Link><Link className="header-pricing-link" href="/pricing">{ar ? "الأسعار" : "Pricing"}</Link><a className="github-button" href="https://github.com/BlyzrHQ/market-signal" target="_blank" rel="noreferrer">GitHub ↗</a><button className="language-switch" type="button" onClick={() => setLocale(ar ? "en" : "ar")}>{ar ? "EN" : "ع"}<span>{ar ? " English" : " العربية"}</span></button></nav></header>

    <section className="hero shell hero-v2" id="top">
      <div className="hero-orbit" aria-hidden="true"><i /><i /><i /><span>282</span></div>
      <div className="hero-copy"><div className="eyebrow"><span className="pulse-dot" /> {ar ? "ذكاء تنافسي مبني على المنتجات" : "Product-led competitive intelligence"}</div><h1>{ar ? <>أدخل نطاقك. <em>واكشف السوق الذي ينافس كل منتج.</em></> : <>Enter your domain. <em>See the market behind every product.</em></>}</h1><p className="hero-lede">{ar ? "نحوّل كتالوجك إلى خريطة منافسين، ثم نطابق المنتجات والأسعار ونحفظ النتيجة في لوحة تحكم قابلة للمراجعة." : "We turn your catalog into a competitor map, match products and public prices, and save the result in a dashboard you can inspect."}</p>
        <form className="domain-form" onSubmit={analyze}><label htmlFor="domain">{ar ? "نطاق شركتك أو رابط الموقع" : "Your company domain or URL"}</label><div className="input-row"><div className="domain-input"><input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder={ar ? "example.com أو الصق الرابط" : "yourcompany.com or paste the full URL"} dir="ltr" /></div><button className="primary-button" type="submit" disabled={isAnalyzing}>{isAnalyzing ? (ar ? "جارٍ إنشاء التقرير…" : "Starting your report…") : (ar ? "اكشف منافسي" : "Map my market")} <span>→</span></button></div><div className="form-note">◇ {ar ? "نسخة تجريبية · مصادر عامة فقط · تقرير محفوظ" : "Beta access · public sources only · saved report"}</div>{analysisError && <div className="analysis-error" role="alert">{analysisError}</div>}</form>
      </div>

      <div className="hero-system" aria-label={ar ? "عرض متحرك لطريقة العمل" : "Animated product workflow preview"}><div className="system-top"><span><i /><i /><i /></span><b>LIVE ANALYSIS</b><em>myjam.co.uk</em></div><div className="system-body"><div className="system-scan"><span>CRAWLING CATALOG</span><strong>1,001 products found</strong><i><b /></i></div><div className="system-flow"><article><span>01</span><div><b>Catalog</b><small>Products, prices, images</small></div><em>1,001</em></article><i /><article><span>02</span><div><b>Competitors</b><small>Discovered by product overlap</small></div><em>5</em></article><i /><article><span>03</span><div><b>Comparisons</b><small>Valid rival prices only</small></div><em>282</em></article></div><div className="system-match"><div className="mini-product"><i style={{ backgroundImage: `url(${products[0].image})` }} /><span><b>Castania Mixed Kernels</b><small>YOU · £18.24</small></span></div><em>matched</em><div className="mini-product rival"><span><b>Castania Mixed Kernels</b><small>RIVAL · £14.99</small></span></div></div></div><footer><span><i /> collecting public evidence</span><b>saved progress</b></footer></div>
    </section>

    <div className="signal-marquee" aria-hidden="true"><div><span>CATALOG DISCOVERY</span><i /> <span>COMPETITOR MAPPING</span><i /> <span>PRODUCT MATCHING</span><i /> <span>PUBLIC PRICE PROOF</span><i /> <span>DECISION SIGNALS</span><i /></div></div>
    <ProofShowcase ar={ar} />
    <section className="landing-final-cta shell"><span>{ar ? "سوقك لا ينتظر." : "Your market is already moving."}</span><h2>{ar ? "ابدأ بنطاق واحد. ودع المنتجات تكشف المنافسة." : "Start with one domain. Let the products reveal the competition."}</h2><a href="#top">{ar ? "أنشئ تقريرك" : "Create your report"} →</a></section>
    <SiteFooter locale={locale} />
  </main>;
}
