"use client";

import { FormEvent, useEffect, useState } from "react";
import { postJson } from "./lib/json-response";

type Locale = "en" | "ar";
type CreateReportResponse =
  | { ok: true; report: { publicId: string }; job: { dispatched: true; runId: string } }
  | { ok: false; error?: string; publicId?: string };

export default function Home() {
  const [locale, setLocale] = useState<Locale>("en");
  const [domain, setDomain] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const ar = locale === "ar";

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = ar ? "rtl" : "ltr";
  }, [ar, locale]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const primaryDomain = domain.trim();
    if (!primaryDomain) {
      setAnalysisError(ar ? "أدخل نطاق شركتك أو رابط موقعها." : "Enter your company domain or website URL.");
      return;
    }
    setIsAnalyzing(true);
    setAnalysisError("");
    try {
      const created = await postJson<CreateReportResponse>("/api/reports", { primaryDomain, locale }, "Persistent report creation");
      if (!created.ok) {
        const failed = created as Extract<CreateReportResponse, { ok: false }>;
        if (failed.publicId) window.location.assign(`/reports/${failed.publicId}/loading`);
        else throw new Error(failed.error || "The background report job could not be started.");
        return;
      }
      window.location.assign(`/reports/${created.report.publicId}/loading`);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "The report could not be started.");
      setIsAnalyzing(false);
    }
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
          <a href="#pillars">{ar ? "ما الذي ستحصل عليه" : "What you get"}</a>
          <a href="#method">{ar ? "منهجنا" : "Our method"}</a>
          <button className="language-switch" type="button" onClick={() => setLocale(ar ? "en" : "ar")} aria-label={ar ? "Switch to English" : "التبديل إلى العربية"}>
            <span aria-hidden="true">{ar ? "EN" : "ع"}</span>{ar ? "English" : "العربية"}
          </button>
        </nav>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span className="pulse-dot" /> {ar ? "معلومات تنافسية مبنية على أدلة عامة" : "Competitive intelligence built from public evidence"}</div>
          <h1>{ar ? <>اعرف إلى أين يتحرك سوقك <em>قبل أن يسبقك.</em></> : <>Know where your market is moving <em>before it moves you.</em></>}</h1>
          <p className="hero-lede">{ar ? "أدخل نطاقاً واحداً. سنجد المنافسين، ونزامن المنتجات والأسعار والصور العامة، ثم نحفظ كل نتيجة في تقرير يمكنك الرجوع إليه." : "Enter one domain. We find the rivals, synchronize public products, prices, and images, and save every result in a report you can revisit."}</p>
          <form className="domain-form" onSubmit={analyze}>
            <label htmlFor="domain">{ar ? "نطاق شركتك أو رابط الموقع" : "Your company domain or URL"}</label>
            <div className="input-row">
              <div className="domain-input"><input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder={ar ? "example.com أو الصق الرابط الكامل" : "yourcompany.com or paste the full URL"} dir="ltr" autoComplete="url" /></div>
              <button className="primary-button" type="submit" disabled={isAnalyzing}>{isAnalyzing ? (ar ? "جارٍ إنشاء التقرير…" : "Starting your report…") : (ar ? "ابحث عن منافسيّ" : "Find my competitors")} <span>{isAnalyzing ? "·" : ar ? "←" : "→"}</span></button>
            </div>
            <div className="form-note"><span className="lock">◇</span> {ar ? "تقرير مجاني · دون حساب · إشارات عامة فقط" : "One free report · no account required · public signals only"}</div>
            {analysisError && <div className="analysis-error" role="alert">{analysisError}</div>}
          </form>
          <div className="trusted-row"><span>{ar ? "مصمم للفرق التي تحتاج إلى سياق واضح" : "Built for teams that need the market explained"}</span><span className="trusted-line" /><span>STARTUPS</span><span>AGENCIES</span><span>ECOMMERCE</span></div>
        </div>

        <div className="hero-preview method-preview" aria-label={ar ? "مراحل التقرير" : "Report phases"}>
          <div className="preview-top"><span className="window-dot coral" /><span className="window-dot amber" /><span className="window-dot green" /><span className="preview-label">MARKET / LIVE JOB</span><span className="preview-time">saved progress</span></div>
          <div className="preview-body">
            <div className="preview-kicker">{ar ? "يستمر حتى إذا أغلقت الصفحة" : "KEEPS WORKING IF YOU CLOSE THE TAB"}</div>
            <div className="preview-title">{ar ? <>تقرير دائم، وليس <strong>نتيجة مؤقتة.</strong></> : <>A persistent report, not <strong>a one-time response.</strong></>}</div>
            <div className="method-preview-list">
              <div><b>01</b><span>{ar ? "نزحف موقعك ونستخرج كتالوج المنتجات القابل للإسناد." : "Crawl your site and extract the attributable product catalog."}</span></div>
              <div><b>02</b><span>{ar ? "نكتشف المنافسين الحقيقيين ونفحص كتالوجاتهم العامة." : "Discover real competitors and inspect their public catalogs."}</span></div>
              <div><b>03</b><span>{ar ? "نطابق المنتجات ونقارن الأسعار ونوضح فجوات الأدلة." : "Match products, compare prices, and expose evidence gaps."}</span></div>
            </div>
            <div className="preview-foot"><span><b>LIVE</b> {ar ? "تقدم محفوظ" : "saved progress"}</span><span><b>PUBLIC</b> {ar ? "مصادر مرتبطة" : "linked sources"}</span><span><b>NO</b> {ar ? "بيانات مؤقتة" : "fixture results"}</span></div>
          </div>
        </div>
      </section>

      <section className="method-section shell" id="pillars">
        <div className="method-copy">
          <div className="eyebrow">{ar ? "ثلاثة أعمدة، تقرير واحد" : "Three pillars, one report"}</div>
          <h2>{ar ? <>اعرف منافسيك. قارن منتجاتك. <em>راقب ظهورهم.</em></> : <>Know the rivals. Compare the products. <em>Watch how they show up.</em></>}</h2>
          <p>{ar ? "لا نعرض لك تفريغاً للصفحات. ننظم النتائج حول القرارات التي تحتاج إلى اتخاذها." : "We do not hand you a page dump. Results are organized around the decisions you need to make."}</p>
        </div>
        <div className="method-steps">
          <div><span>01</span><strong>{ar ? "المنافسون" : "Competitors"}</strong><p>{ar ? "اكتشاف السوق والتحقق من المنافسين مع روابط الأدلة." : "Market discovery and verified rivals with evidence links."}</p></div>
          <div><span>02</span><strong>{ar ? "المنتجات" : "Products"}</strong><p>{ar ? "مطابقة دلالية للمنتجات مع السعر والصورة والمقارنة." : "Semantic product matching with price, image, and comparison context."}</p></div>
          <div><span>03</span><strong>{ar ? "الإعلانات — قريباً" : "Ads — Coming soon"}</strong><p>{ar ? "مراقبة ظهور المنافسين الإعلاني قيد الإعداد." : "Competitor advertising monitoring is in development."}</p></div>
        </div>
      </section>

      <section className="method-section shell" id="method">
        <div className="method-copy"><div className="eyebrow">{ar ? "الإشارة، لا الضوضاء" : "The signal, not the spectacle"}</div><h2>{ar ? <>شاهد ما نعرفه. <em>وشاهد كيف عرفناه.</em></> : <>See what we know. <em>See how we know it.</em></>}</h2><p>{ar ? "يفصل Market Signal بين الرصد العام واستنتاجات الذكاء الاصطناعي والتقديرات والتوصيات." : "Market Signal separates public observations from AI inferences, estimates, and recommendations."}</p></div>
        <div className="method-steps"><div><span>01</span><strong>{ar ? "نجمع" : "Collect"}</strong><p>{ar ? "صفحات وكتالوجات وأسعار وصور عامة مرتبطة بمصادرها." : "Public pages, catalogs, prices, and images linked to their sources."}</p></div><div><span>02</span><strong>{ar ? "نربط" : "Connect"}</strong><p>{ar ? "نوحد المنتجات والشركات والمصادر عبر السوق." : "Normalize products, companies, and sources across the market."}</p></div><div><span>03</span><strong>{ar ? "نشرح" : "Explain"}</strong><p>{ar ? "نحوّل الأدلة إلى مقارنة وقرار قابل للتنفيذ." : "Turn evidence into a comparison and an actionable decision."}</p></div></div>
      </section>

      <footer className="site-footer shell"><a className="brand" href="#top"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></a><span>{ar ? "معلومات عامة تتحول إلى قرار مفيد." : "Public intelligence, made useful."}</span><span>© 2026 Market Signal</span></footer>
    </main>
  );
}
