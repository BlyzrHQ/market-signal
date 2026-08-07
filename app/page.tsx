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
          <a className="header-pricing-link" href="#pricing">{ar ? "الخطط والأسعار" : "Plans & pricing"}</a>
          <a className="github-button" href="https://github.com/BlyzrHQ/market-signal" target="_blank" rel="noreferrer" aria-label={ar ? "افتح مستودع Market Signal على GitHub" : "Open the Market Signal repository on GitHub"}>
            <span aria-hidden="true">⌘</span>{ar ? "مفتوح المصدر" : "GitHub"}
          </a>
          <button className="language-switch" type="button" onClick={() => setLocale(ar ? "en" : "ar")} aria-label={ar ? "Switch to English" : "التبديل إلى العربية"}>
            <span aria-hidden="true">{ar ? "EN" : "ع"}</span>{ar ? "English" : "العربية"}
          </button>
        </nav>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span className="pulse-dot" /> {ar ? "معلومات تنافسية مبنية على أدلة عامة" : "Competitive intelligence built from public evidence"}</div>
          <h1>{ar ? <>اعرف إلى أين يتحرك سوقك <em>قبل أن يسبقك.</em></> : <>Know where your market is moving <em>before it moves you.</em></>}</h1>
          <p className="hero-lede">{ar ? "أدخل نطاقاً واحداً. نرسم خريطة منتجاتك أولاً، ثم نستخدمها لاكتشاف المنافسين الحقيقيين وننشر فقط المقارنات المدعومة بسعر منافس عام، مع حفظ كل نتيجة في تقرير يمكنك الرجوع إليه." : "Enter one domain. We map your products first, use them to discover real competitors, and publish only comparisons backed by a public rival price—then save everything in a report you can revisit."}</p>
          <form className="domain-form" onSubmit={analyze}>
            <label htmlFor="domain">{ar ? "نطاق شركتك أو رابط الموقع" : "Your company domain or URL"}</label>
            <div className="input-row">
              <div className="domain-input"><input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder={ar ? "example.com أو الصق الرابط الكامل" : "yourcompany.com or paste the full URL"} dir="ltr" autoComplete="url" /></div>
              <button className="primary-button" type="submit" disabled={isAnalyzing}>{isAnalyzing ? (ar ? "جارٍ إنشاء التقرير…" : "Starting your report…") : (ar ? "ابحث عن منافسيّ" : "Find my competitors")} <span>{isAnalyzing ? "·" : ar ? "←" : "→"}</span></button>
            </div>
            <div className="form-note"><span className="lock">◇</span> {ar ? "وصول تجريبي · دون رسوم أثناء قياس الاستخدام · إشارات عامة فقط" : "Beta access · no charge while usage is measured · public signals only"}</div>
            {analysisError && <div className="analysis-error" role="alert">{analysisError}</div>}
          </form>
          <div className="hero-links" aria-label={ar ? "الخطط والمصدر" : "Plans and source code"}>
            <a className="hero-pricing-button" href="#pricing">{ar ? "شاهد الخطط ابتداءً من 8$" : "See plans from $8"}<span aria-hidden="true">↓</span></a>
            <a className="hero-github-link" href="https://github.com/BlyzrHQ/market-signal" target="_blank" rel="noreferrer">{ar ? "استضفه بنفسك على GitHub" : "Self-host from GitHub"}<span aria-hidden="true">↗</span></a>
          </div>
          <div className="trusted-row"><span>{ar ? "مصمم للفرق التي تحتاج إلى سياق واضح" : "Built for teams that need the market explained"}</span><span className="trusted-line" /><span>STARTUPS</span><span>AGENCIES</span><span>ECOMMERCE</span></div>
        </div>

        <div className="hero-preview method-preview" aria-label={ar ? "مراحل التقرير" : "Report phases"}>
          <div className="preview-top"><span className="window-dot coral" /><span className="window-dot amber" /><span className="window-dot green" /><span className="preview-label">MARKET / LIVE JOB</span><span className="preview-time">saved progress</span></div>
          <div className="preview-body">
            <div className="preview-kicker">{ar ? "يستمر حتى إذا أغلقت الصفحة" : "KEEPS WORKING IF YOU CLOSE THE TAB"}</div>
            <div className="preview-title">{ar ? <>تقرير دائم، وليس <strong>نتيجة مؤقتة.</strong></> : <>A persistent report, not <strong>a one-time response.</strong></>}</div>
            <div className="method-preview-list">
              <div><b>01</b><span>{ar ? "نزحف موقعك ونبني كتالوج منتجاتك أولاً." : "Crawl your site and build your product catalog first."}</span></div>
              <div><b>02</b><span>{ar ? "نبحث بكل منتج عن المنافسين الذين يبيعون بدائل حقيقية." : "Use each product to discover rivals selling real alternatives."}</span></div>
              <div><b>03</b><span>{ar ? "ننشر المقارنة فقط عندما نجد سعراً عاماً صالحاً للمنافس." : "Publish a comparison only when a valid public rival price is found."}</span></div>
            </div>
            <div className="preview-foot"><span><b>LIVE</b> {ar ? "تقدم محفوظ" : "saved progress"}</span><span><b>PUBLIC</b> {ar ? "مصادر مرتبطة" : "linked sources"}</span><span><b>NO</b> {ar ? "بيانات مؤقتة" : "fixture results"}</span></div>
          </div>
        </div>
      </section>

      <section className="method-section shell" id="pillars">
        <div className="method-copy">
          <div className="eyebrow">{ar ? "ثلاثة أعمدة، تقرير واحد" : "Three pillars, one report"}</div>
          <h2>{ar ? <>اعرف منافسيك. قارن منتجاتك. <em>اعرف موقعك بينهم.</em></> : <>Know the rivals. Compare the products. <em>See where you stand.</em></>}</h2>
          <p>{ar ? "لا نعرض لك تفريغاً للصفحات. ننظم النتائج حول القرارات التي تحتاج إلى اتخاذها." : "We do not hand you a page dump. Results are organized around the decisions you need to make."}</p>
        </div>
        <div className="method-steps">
          <div><span>01</span><strong>{ar ? "المنافسون" : "Competitors"}</strong><p>{ar ? "اكتشاف السوق والتحقق من المنافسين مع روابط الأدلة." : "Market discovery and verified rivals with evidence links."}</p></div>
          <div><span>02</span><strong>{ar ? "المنتجات" : "Products"}</strong><p>{ar ? "مطابقة دلالية للمنتجات مع السعر والصورة والمقارنة." : "Semantic product matching with price, image, and comparison context."}</p></div>
          <div><span>03</span><strong>{ar ? "المقارنة المعيارية" : "Benchmark"}</strong><p>{ar ? "قارن سهولة الوصول إلى المنتجات وجودة المعلومات والثقة وتجربة الشراء بالسوق." : "Compare product access, information quality, trust, and purchase experience against the market."}</p></div>
        </div>
      </section>

      <section className="method-section shell" id="method">
        <div className="method-copy"><div className="eyebrow">{ar ? "الإشارة، لا الضوضاء" : "The signal, not the spectacle"}</div><h2>{ar ? <>شاهد ما نعرفه. <em>وشاهد كيف عرفناه.</em></> : <>See what we know. <em>See how we know it.</em></>}</h2><p>{ar ? "يفصل Market Signal بين الرصد العام واستنتاجات الذكاء الاصطناعي والتقديرات والتوصيات." : "Market Signal separates public observations from AI inferences, estimates, and recommendations."}</p></div>
        <div className="method-steps"><div><span>01</span><strong>{ar ? "نجمع" : "Collect"}</strong><p>{ar ? "صفحات وكتالوجات وأسعار وصور وإشارات عامة لتجربة الاستخدام." : "Public pages, catalogs, prices, images, and experience signals."}</p></div><div><span>02</span><strong>{ar ? "نربط" : "Connect"}</strong><p>{ar ? "نوحد المنتجات والشركات والمصادر عبر السوق." : "Normalize products, companies, and sources across the market."}</p></div><div><span>03</span><strong>{ar ? "نشرح" : "Explain"}</strong><p>{ar ? "نحوّل الأدلة إلى مقارنة وقرار قابل للتنفيذ." : "Turn evidence into a comparison and an actionable decision."}</p></div></div>
      </section>

      <section className="pricing-section" id="pricing">
        <div className="shell">
          <div className="pricing-heading">
            <div><div className="eyebrow">{ar ? "أسعار الإطلاق" : "Launch pricing"}</div><h2>{ar ? <>ابدأ بخمس تقارير. <em>وتوسع عندما يتوسع سوقك.</em></> : <>Start with five reports. <em>Scale when your market does.</em></>}</h2></div>
            <p>{ar ? "كل تشغيل مكتمل ينشئ تقريراً محفوظاً. حد المنتجات يعني منتجاتك التي نبحث عن بدائل لها ونقيّمها، وليس عدداً مضموناً من المطابقات." : "Each completed run creates one saved report. Product limits mean your catalog items assessed against possible rivals—not a promise of that many accepted matches."}</p>
          </div>

          <div className="self-hosted-plan">
            <div><span>{ar ? "مفتوح المصدر" : "Open source"}</span><strong>{ar ? "الاستضافة الذاتية مجانية" : "Self-host for free"}</strong></div>
            <p>{ar ? "شغّل النواة الكاملة ببنيتك ومفاتيح مزودي الخدمة الخاصة بك. لا تفرض Market Signal حدوداً على الاستخدام الذاتي." : "Run the complete core with your own infrastructure and provider keys. Market Signal does not impose hosted-plan limits on your installation."}</p>
            <a className="open-source-cta" href="https://github.com/BlyzrHQ/market-signal" target="_blank" rel="noreferrer">{ar ? "افتح المشروع على GitHub ↗" : "Open on GitHub ↗"}</a>
          </div>

          <div className="pricing-grid">
            <article className="pricing-card featured">
              <div className="plan-top"><span>{ar ? "للبداية" : "Easy start"}</span><b>{ar ? "وصول مبكر" : "Early access"}</b></div>
              <h3>Starter</h3><div className="plan-price"><strong>$8</strong><span>{ar ? "/ شهر" : "/ month"}</span></div>
              <p>{ar ? "لصاحب مشروع يريد صورة واضحة عن سوقه دون التزام كبير." : "For one owner who wants a clear market view without a large commitment."}</p>
              <ul><li><b>5</b> {ar ? "تقارير مكتملة شهرياً" : "completed reports / month"}</li><li><b>20</b> {ar ? "منتجاً يتم تحليله في التقرير" : "products analyzed / report"}</li><li><b>1</b> {ar ? "نطاق مراقب ومقعد واحد" : "monitored domain · 1 seat"}</li><li>{ar ? "تحديثات يدوية" : "Manual refreshes"}</li></ul>
              <a className="plan-cta" href="#top">{ar ? "ابدأ في النسخة التجريبية" : "Start in beta"}</a>
            </article>

            <article className="pricing-card">
              <div className="plan-top"><span>{ar ? "للعمل الفردي" : "For operators"}</span><b>{ar ? "وصول مبكر" : "Early access"}</b></div>
              <h3>Solo</h3><div className="plan-price"><strong>$29</strong><span>{ar ? "/ شهر" : "/ month"}</span></div>
              <p>{ar ? "لمن يتابع عدة منافسين ويحتاج مساحة أكبر للمنتجات." : "For an operator tracking a broader catalog and several market rivals."}</p>
              <ul><li><b>10</b> {ar ? "تقارير مكتملة شهرياً" : "completed reports / month"}</li><li><b>50</b> {ar ? "منتجاً يتم تحليله في التقرير" : "products analyzed / report"}</li><li><b>3</b> {ar ? "نطاقات مراقبة ومقعد واحد" : "monitored domains · 1 seat"}</li><li>{ar ? "جدولة شهرية" : "Monthly scheduling"}</li></ul>
              <a className="plan-cta secondary" href="#top">{ar ? "اطلب الوصول المبكر" : "Request early access"}</a>
            </article>

            <article className="pricing-card future">
              <div className="plan-top"><span>{ar ? "للفرق" : "For teams"}</span><b>{ar ? "قريباً" : "Coming soon"}</b></div>
              <h3>Growth</h3><div className="plan-price"><strong>$79</strong><span>{ar ? "/ شهر" : "/ month"}</span></div>
              <p>{ar ? "لفريق يحتاج مراقبة أسبوعية وتغطية كتالوج أعمق." : "For a team that needs weekly monitoring and deeper catalog coverage."}</p>
              <ul><li><b>40</b> {ar ? "تقريراً مكتملاً شهرياً" : "completed reports / month"}</li><li><b>500</b> {ar ? "منتج يتم تحليله في التقرير" : "products analyzed / report"}</li><li><b>10</b> {ar ? "نطاقات مراقبة و3 مقاعد" : "monitored domains · 3 seats"}</li><li>{ar ? "تصدير ومشاركة وجدولة أسبوعية" : "Exports, sharing, weekly scheduling"}</li></ul>
              <a className="plan-cta secondary" href="#top">{ar ? "انضم إلى قائمة الانتظار" : "Join the waitlist"}</a>
            </article>

            <article className="pricing-card future">
              <div className="plan-top"><span>{ar ? "للعملاء المتعددين" : "For client work"}</span><b>{ar ? "قريباً" : "Coming soon"}</b></div>
              <h3>Agency</h3><div className="plan-price"><strong>$199</strong><span>{ar ? "/ شهر" : "/ month"}</span></div>
              <p>{ar ? "للوكالات التي تدير أسواقاً وتقارير متعددة للعملاء." : "For agencies managing multiple client markets and report workspaces."}</p>
              <ul><li><b>120</b> {ar ? "تقريراً مكتملاً شهرياً" : "completed reports / month"}</li><li><b>1,000</b> {ar ? "منتج يتم تحليله في التقرير" : "products analyzed / report"}</li><li><b>30</b> {ar ? "نطاق مراقبة و10 مقاعد" : "monitored domains · 10 seats"}</li><li>{ar ? "مساحات عملاء وتصدير بعلامتك" : "Client workspaces and branded exports"}</li></ul>
              <a className="plan-cta secondary" href="#top">{ar ? "انضم إلى قائمة الانتظار" : "Join the waitlist"}</a>
            </article>
          </div>

          <p className="pricing-disclosure">{ar ? "هذه أهداف أسعار الإطلاق وليست فواتير نشطة بعد. تبدأ الاشتراكات بعد أن تثبت النسخة التجريبية المقاسة التكلفة وجودة التقارير وقدرة الكتالوج العميق. لا توجد رسوم تجاوز مفاجئة." : "These are launch pricing targets, not active billing yet. Subscriptions open after the metered beta validates cost, report quality, and deep-catalog capacity. There are no surprise overage charges."}</p>
        </div>
      </section>

      <footer className="site-footer shell"><a className="brand" href="#top"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></a><span>{ar ? "معلومات عامة تتحول إلى قرار مفيد." : "Public intelligence, made useful."}</span><span>© 2026 Market Signal</span></footer>
    </main>
  );
}
