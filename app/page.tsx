"use client";
/* eslint-disable @next/next/no-img-element -- local proof snapshots avoid the vinext image proxy */

import { FormEvent, KeyboardEvent, useEffect, useState } from "react";
import Link from "next/link";
import { SiteFooter } from "./components/site-footer";
import { postJson } from "./lib/json-response";

type Locale = "en" | "ar";
type ProofView = "dashboard" | "competitors" | "catalog";
type CreateReportResponse =
  | { ok: true; report: { publicId: string }; job: { dispatched: true; runId: string } }
  | { ok: false; error?: string; publicId?: string };

const proofViews: ProofView[] = ["dashboard", "competitors", "catalog"];

const products = [
  { name: "Castania Mixed Kernels 450G", image: "/demo/castania-kernels.jpg", source: "https://myjam.co.uk/products/castania-mixed-kernels-450g", yourPrice: "£18.24", rival: "bakkali.app", rivalPrice: "£14.99", signal: "Rival is £3.25 lower" },
  { name: "Okra 500g", image: "/demo/okra.jpg", source: "https://myjam.co.uk/products/okra-500g", yourPrice: "£7.10", rival: "24shopping.shop", rivalPrice: "£7.99", signal: "You are £0.89 lower" },
  { name: "Iceberg Lettuce Each", image: "/demo/iceberg-lettuce.jpg", source: "https://myjam.co.uk/products/iceberg-lettuce-each", yourPrice: "£1.95", rival: "bakkali.app", rivalPrice: "Public price", signal: "AI-assessed close substitute" },
];

function ProofShowcase({ ar }: { ar: boolean }) {
  const [view, setView] = useState<ProofView>("dashboard");

  function selectWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? proofViews.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + proofViews.length) % proofViews.length;
    setView(proofViews[next]);
    document.getElementById(`proof-tab-${proofViews[next]}`)?.focus();
  }

  return (
    <section className="proof-section shell" id="proof">
      <header className="proof-heading">
        <div><span>{ar ? "دليل، وليس وعوداً" : "Proof, not promises"}</span><h2>{ar ? "شاهد التقرير قبل أن تنشئ تقريرك." : "See the work before you run it."}</h2></div>
        <div><p>{ar ? "لقطة موثقة من تشغيل MyJam العام: تغطية محدودة، تمت الملاحظة في 8 أغسطس 2026." : "A documented snapshot from a public MyJam run: limited coverage, observed 8 August 2026."}</p><a href="https://myjam.co.uk" target="_blank" rel="noreferrer">{ar ? "افتح الكتالوج المصدر" : "Open the source catalog"} ↗</a></div>
      </header>

      <div className="proof-browser">
        <div className="proof-browser-top"><span><i /><i /><i /></span><b>signal.blyzr.com / myjam.co.uk</b><em>{ar ? "لقطة تقرير · تغطية محدودة" : "REPORT SNAPSHOT · LIMITED COVERAGE"}</em></div>
        <div className="proof-tabs" role="tablist" aria-label={ar ? "معاينات التقرير" : "Report previews"}>
          {proofViews.map((item, index) => <button id={`proof-tab-${item}`} key={item} role="tab" tabIndex={view === item ? 0 : -1} aria-selected={view === item} aria-controls={`proof-panel-${item}`} onKeyDown={(event) => selectWithKeyboard(event, index)} onClick={() => setView(item)}><span>0{index + 1}</span>{item === "dashboard" ? (ar ? "لوحة التحكم" : "Dashboard") : item === "competitors" ? (ar ? "المنافسون" : "Competitors") : (ar ? "كتالوج المنتجات" : "Product catalog")}</button>)}
        </div>

        <div className="proof-stage" id={`proof-panel-${view}`} role="tabpanel" aria-labelledby={`proof-tab-${view}`} tabIndex={0} key={view}>
          {view === "dashboard" && <div className="proof-dashboard">
            <aside><strong>Market Signal</strong><span className="active">{ar ? "نظرة عامة" : "Overview"}</span><span>{ar ? "المنافسون" : "Competitors"} <b>5</b></span><span>{ar ? "المطابقات" : "Matches"} <b>282</b></span><span>{ar ? "المعيار" : "Benchmark"}</span></aside>
            <div className="proof-canvas">
              <div className="proof-title"><div><span>MYJAM.CO.UK</span><h3>{ar ? "سوقك، على الخريطة." : "Your market, mapped."}</h3></div><b>{ar ? "وكالة · حد 1,000 منتج" : "Agency · 1,000-product limit"}</b></div>
              <div className="proof-metrics"><article><span>{ar ? "منتجات تم العثور عليها" : "PRODUCTS FOUND"}</span><strong>1,001</strong><small>{ar ? "فهرسة الكتالوج العام" : "Public catalog indexed"}</small></article><article><span>{ar ? "مطابقات مسعّرة" : "PRICED MATCHES"}</span><strong>282</strong><small>{ar ? "سعر المنافس مرصود؛ الهوية مقيمة بالذكاء الاصطناعي" : "Rival price observed; identity AI-assessed"}</small></article><article><span>{ar ? "منافسون على الخريطة" : "RIVALS MAPPED"}</span><strong>5</strong><small>{ar ? "اكتشاف يقوده المنتج" : "Product-led discovery"}</small></article></div>
              <div className="proof-chart"><header><strong>{ar ? "مصادر المطابقات المسعّرة" : "Where the priced matches came from"}</strong><span>{ar ? "282 إجمالاً" : "282 total"}</span></header>{[["24shopping.shop",140],["bakkali.app",101],["mymeatshop.co.uk",34],[ar ? "أخرى" : "Other",7]].map(([label, value]) => <div key={label}><span>{label}</span><i><b style={{ width: `${Number(value) / 1.4}%` }} /></i><strong>{value}</strong></div>)}</div>
            </div>
          </div>}

          {view === "competitors" && <div className="proof-competitors">
            <div className="competitor-map"><div className="market-core"><span>{ar ? "أنت" : "YOU"}</span><strong>myjam.co.uk</strong><small>{ar ? "1,001 منتج" : "1,001 products"}</small></div>{[{name:"24shopping",count:140,cls:"one"},{name:"Bakkali",count:101,cls:"two"},{name:"My Meat Shop",count:34,cls:"three"},{name:"Desii Basket",count:4,cls:"four"}].map((rival) => <div className={`rival-node ${rival.cls}`} key={rival.name}><span>{rival.count}</span><strong>{rival.name}</strong><small>{ar ? "مطابقات مسعّرة" : "priced matches"}</small></div>)}</div>
            <div className="competitor-ledger"><header><span>{ar ? "اكتشاف يقوده المنتج" : "PRODUCT-LED DISCOVERY"}</span><strong>{ar ? "من يتداخل فعلاً مع رفوفك؟" : "Who actually overlaps your shelf?"}</strong></header>{[["24shopping.shop","140",ar ? "أعلى تداخل للمنتجات" : "Highest product overlap"],["bakkali.app","101",ar ? "تداخل قوي في البقالة" : "Strong grocery overlap"],["mymeatshop.co.uk","34",ar ? "تداخل مركّز في اللحوم الحلال" : "Focused halal meat overlap"]].map(([domain,count,note], index) => <article key={domain}><i>0{index+1}</i><div><strong>{domain}</strong><span>{note}</span></div><b>{count}</b></article>)}</div>
          </div>}

          {view === "catalog" && <div className="proof-catalog"><header><div><span>{ar ? "منتج × منتج" : "PRODUCT × PRODUCT"}</span><strong>{ar ? "لا نعرض إلا المقارنات التي لها سعر منافس عام" : "Only comparisons with a public rival price"}</strong></div><b>{ar ? "282 مطابقة مسعّرة ومقيّمة بالذكاء الاصطناعي" : "282 priced, AI-assessed matches"}</b></header><div className="catalog-table"><div className="catalog-head"><span>{ar ? "منتجك" : "Your product"}</span><span>{ar ? "سعرك" : "Your price"}</span><span>{ar ? "أقرب منافس" : "Closest rival"}</span><span>{ar ? "سعر المنافس" : "Rival price"}</span><span>{ar ? "إشارة القرار" : "Decision signal"}</span></div>{products.map((product) => <article key={product.name}><div className="catalog-product"><a href={product.source} target="_blank" rel="noreferrer"><img src={product.image} alt={`${product.name} from the MyJam public catalog`} width="50" height="50" /></a><strong>{product.name}</strong></div><b>{product.yourPrice}</b><span>{product.rival}</span><b>{product.rivalPrice}</b><em>{ar && product.signal === "AI-assessed close substitute" ? "بديل قريب مقيّم بالذكاء الاصطناعي" : product.signal}</em></article>)}</div></div>}
        </div>
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

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("lang") !== "ar") return;
    const timer = window.setTimeout(() => setLocale("ar"), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = ar ? "rtl" : "ltr";
    return () => {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    };
  }, [ar, locale]);

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
    <header className="site-header shell"><a className="brand" href="#top"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span><span className="beta-pill">BETA</span></a><nav className="header-nav"><a href="#proof">{ar ? "شاهد المنتج" : "Product proof"}</a><Link href={ar ? "/how-it-works?lang=ar" : "/how-it-works"}>{ar ? "كيف يعمل" : "How it works"}</Link><Link className="header-pricing-link" href={ar ? "/pricing?lang=ar" : "/pricing"}>{ar ? "الأسعار" : "Pricing"}</Link><a className="github-button" href="https://github.com/BlyzrHQ/market-signal" target="_blank" rel="noreferrer">GitHub ↗</a><button className="language-switch" type="button" onClick={() => setLocale(ar ? "en" : "ar")}>{ar ? "EN" : "ع"}<span>{ar ? " English" : " العربية"}</span></button></nav></header>

    <section className="hero shell hero-v2" id="top">
      <div className="hero-orbit" aria-hidden="true"><i /><i /><i /><span>282</span></div>
      <div className="hero-copy"><div className="eyebrow"><span className="pulse-dot" /> {ar ? "ذكاء تنافسي مبني على المنتجات" : "Product-led competitive intelligence"}</div><h1>{ar ? <>أدخل نطاقك. <em>واكشف السوق الذي ينافس كل منتج.</em></> : <>Enter your domain. <em>See the market behind every product.</em></>}</h1><p className="hero-lede">{ar ? "نحوّل كتالوجك إلى خريطة منافسين، ثم نطابق المنتجات والأسعار ونحفظ النتيجة في لوحة تحكم قابلة للمراجعة." : "We turn your catalog into a competitor map, match products and public prices, and save the result in a dashboard you can inspect."}</p>
        <form className="domain-form" onSubmit={analyze}><label htmlFor="domain">{ar ? "نطاق شركتك أو رابط الموقع" : "Your company domain or URL"}</label><div className="input-row"><div className="domain-input"><input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder={ar ? "example.com أو الصق الرابط" : "yourcompany.com or paste the full URL"} dir="ltr" /></div><button className="primary-button" type="submit" disabled={isAnalyzing}>{isAnalyzing ? (ar ? "جارٍ إنشاء التقرير…" : "Starting your report…") : (ar ? "اكشف منافسي" : "Map my market")} <span>→</span></button></div><div className="form-note">◇ {ar ? "نسخة تجريبية · مصادر عامة فقط · تقرير محفوظ" : "Beta access · public sources only · saved report"}</div>{analysisError && <div className="analysis-error" role="alert">{analysisError}</div>}</form>
      </div>

      <div className="hero-system" aria-label={ar ? "مثال متحرك لتشغيل تقرير MyJam المسجّل" : "Animated example of a recorded MyJam report run"}><div className="system-top"><span><i /><i /><i /></span><b>{ar ? "مثال لسير العمل" : "EXAMPLE WORKFLOW"}</b><em>{ar ? "تشغيل MyJam مسجّل" : "RECORDED MYJAM RUN"}</em></div><div className="system-body"><div className="system-scan"><span>{ar ? "فهرسة الكتالوج مكتملة" : "CATALOG INDEX COMPLETE"}</span><strong>{ar ? "تم العثور على 1,001 منتج" : "1,001 products found"}</strong><i><b /></i></div><div className="system-flow"><article><span>01</span><div><b>{ar ? "الكتالوج" : "Catalog"}</b><small>{ar ? "منتجات وأسعار وصور" : "Products, prices, images"}</small></div><em>1,001</em></article><i /><article><span>02</span><div><b>{ar ? "المنافسون" : "Competitors"}</b><small>{ar ? "اكتشاف عبر تداخل المنتجات" : "Discovered by product overlap"}</small></div><em>5</em></article><i /><article><span>03</span><div><b>{ar ? "المقارنات" : "Comparisons"}</b><small>{ar ? "أسعار منافسين عامة فقط" : "Public rival prices only"}</small></div><em>282</em></article></div><div className="system-match"><div className="mini-product"><img src={products[0].image} alt="Castania Mixed Kernels from the MyJam public catalog" width="38" height="38" /><span><b>Castania Mixed Kernels</b><small>{ar ? "أنت" : "YOU"} · £18.24</small></span></div><em>{ar ? "مطابقة مقيمة بالذكاء الاصطناعي" : "AI-assessed match"}</em><div className="mini-product rival"><span><b>Castania Mixed Kernels</b><small>{ar ? "المنافس" : "RIVAL"} · £14.99</small></span></div></div></div><footer><span><i /> {ar ? "تم جمع الأدلة العامة" : "public evidence collected"}</span><b>{ar ? "لقطة محفوظة" : "saved snapshot"}</b></footer></div>
    </section>

    <div className="signal-marquee" aria-hidden="true"><div><span>CATALOG DISCOVERY</span><i /> <span>COMPETITOR MAPPING</span><i /> <span>PRODUCT MATCHING</span><i /> <span>PUBLIC PRICE PROOF</span><i /> <span>DECISION SIGNALS</span><i /></div></div>
    <ProofShowcase ar={ar} />
    <section className="landing-final-cta shell"><span>{ar ? "سوقك لا ينتظر." : "Your market is already moving."}</span><h2>{ar ? "ابدأ بنطاق واحد. ودع المنتجات تكشف المنافسة." : "Start with one domain. Let the products reveal the competition."}</h2><a href="#top">{ar ? "أنشئ تقريرك" : "Create your report"} →</a></section>
    <SiteFooter locale={locale} />
  </main>;
}
