"use client";

import type { CSSProperties } from "react";
import { benchmarkGapAction, orderBenchmarkPositions } from "../lib/benchmark-presentation";

type Block = Record<string, unknown>;
type Metric = { score: number | null; sampleSize: number; observed: Record<string, unknown>; formula: string; sourceUrls: string[] };
type DomainBenchmark = {
  domain: string;
  role: string;
  observedAt: string;
  assessmentStatus: "measured" | "not-assessed";
  assessmentReason: string;
  response: Metric;
  images: Metric;
  information: Metric;
  productAccess: Metric;
  purchasePath: Metric & { minimumPublicSteps: number | null };
  trust: Metric;
  mobileAccessibility: Metric;
};

const METRICS = ["response", "images", "information", "productAccess", "purchasePath", "trust", "mobileAccessibility"] as const;
type MetricKey = typeof METRICS[number];
const SCORE_METRICS = ["images", "information", "productAccess", "purchasePath", "trust", "mobileAccessibility"] as const satisfies readonly MetricKey[];

const COPY: Record<MetricKey, { en: string; ar: string; hintEn: string; hintAr: string }> = {
  response: { en: "Crawl response", ar: "استجابة الموقع", hintEn: "Directional server-response proxy", hintAr: "مؤشر اتجاهي لاستجابة الخادم" },
  images: { en: "Image readiness", ar: "جاهزية الصور", hintEn: "Coverage, alt text, responsive markup", hintAr: "التغطية والنص البديل والاستجابة" },
  information: { en: "Product information", ar: "معلومات المنتج", hintEn: "Price, image, description and identifiers", hintAr: "السعر والصورة والوصف والمعرّفات" },
  productAccess: { en: "Product access", ar: "الوصول للمنتج", hintEn: "How directly products surface publicly", hintAr: "مدى ظهور المنتجات والوصول إليها" },
  purchasePath: { en: "Purchase path", ar: "مسار الشراء", hintEn: "Public cart and checkout controls", hintAr: "عناصر السلة والدفع العامة" },
  trust: { en: "Trust readiness", ar: "جاهزية الثقة", hintEn: "Shipping, returns, contact and policies", hintAr: "الشحن والإرجاع والتواصل والسياسات" },
  mobileAccessibility: { en: "Mobile & access", ar: "الجوال والوصول", hintEn: "Viewport, language and image alternatives", hintAr: "العرض واللغة وبدائل الصور" },
};

function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown) { return Array.isArray(value) ? value : []; }
function numberOrNull(value: unknown) { const parsed = Number(value); return value !== null && value !== "" && Number.isFinite(parsed) ? parsed : null; }
function safeUrl(value: unknown) { const url = typeof value === "string" ? value : ""; return /^https?:\/\/[^\s]+$/i.test(url) ? url : ""; }
function metric(value: unknown): Metric { const item = object(value); return { score: numberOrNull(item.score), sampleSize: Number(item.sampleSize) || 0, observed: object(item.observed), formula: String(item.formula || ""), sourceUrls: list(item.sourceUrls).map(String).filter(safeUrl) }; }
function domain(value: unknown): DomainBenchmark {
  const item = object(value); const purchase = metric(item.purchasePath);
  const metrics = { response: metric(item.response), images: metric(item.images), information: metric(item.information), productAccess: metric(item.productAccess), purchasePath: { ...purchase, minimumPublicSteps: numberOrNull(object(item.purchasePath).minimumPublicSteps) }, trust: metric(item.trust), mobileAccessibility: metric(item.mobileAccessibility) };
  const assessmentStatus = item.assessmentStatus === "not-assessed" ? "not-assessed" : "measured";
  return { domain: String(item.domain || ""), role: String(item.role || ""), observedAt: String(item.observedAt || ""), assessmentStatus, assessmentReason: String(item.assessmentReason || ""), ...metrics };
}
function median(values: number[]) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2); }
function score(metricValue: Metric) { return metricValue.score === null ? null : Math.max(0, Math.min(100, metricValue.score)); }
function assessedDate(value: string, ar: boolean) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Intl.DateTimeFormat(ar ? "ar" : "en", { dateStyle: "medium", timeZone: "UTC" }).format(parsed) : ""; }

function markerStyle(value: number): CSSProperties {
  return { insetInlineStart: `${value}%` };
}

export function ExperienceBenchmark({ block, primaryDomain, ar }: { block?: Block; primaryDomain: string; ar: boolean }) {
  const domains = list(block?.domains).map(domain).filter((item) => item.domain).sort((left, right) => Number(right.domain === primaryDomain) - Number(left.domain === primaryDomain));
  const primary = domains.find((item) => item.domain === primaryDomain);
  if (!block || !primary) return <section className="benchmark-unavailable"><span>{ar ? "يلزم تقرير جديد" : "NEW RUN REQUIRED"}</span><h2>{ar ? "هذا التقرير أقدم من قياسات التجربة المقارنة" : "This report predates the experience benchmark"}</h2><p>{ar ? "شغّل تقريراً جديداً لقياس سرعة الاستجابة، جاهزية الصور، معلومات المنتجات، سهولة الوصول ومسار الشراء عبر المنافسين." : "Run a fresh report to measure response speed, image readiness, product information, product access, and the public purchase path across verified rivals."}</p></section>;

  const measuredRivals = domains.filter((item) => item.domain !== primaryDomain && item.assessmentStatus === "measured");
  const market = SCORE_METRICS.map((key) => {
    const rivalScores = measuredRivals.map((item) => score(item[key])).filter((value): value is number => value !== null);
    const primaryScore = score(primary[key]);
    const knownScores = rivalScores.length ? [primaryScore, ...rivalScores].filter((value): value is number => value !== null) : [];
    return { key, median: median(knownScores), leader: knownScores.length ? Math.max(...knownScores) : null, rivalCount: rivalScores.length };
  });
  const positionedMarket = orderBenchmarkPositions(market.map((item) => ({ ...item, yours: score(primary[item.key]) })));
  const opportunities = market.map((item) => ({ ...item, yours: score(primary[item.key]), gap: item.median === null || score(primary[item.key]) === null ? null : item.median - (score(primary[item.key]) || 0) })).filter((item) => item.gap !== null && item.gap > 0).sort((a, b) => (b.gap || 0) - (a.gap || 0));
  const advantages = positionedMarket.filter((item) => item.band === "ahead").sort((left, right) => (right.delta || 0) - (left.delta || 0));
  const comparedDimensions = market.filter((item) => item.rivalCount > 0).length;
  const wins = market.filter((item) => item.rivalCount > 0 && score(primary[item.key]) !== null && score(primary[item.key]) === item.leader).length;
  const primaryResponse = numberOrNull(primary.response.observed.medianMs);
  const responseValues = domains.map((item) => numberOrNull(item.response.observed.medianMs)).filter((value): value is number => value !== null);
  const maxResponse = Math.max(...responseValues, 1);
  const imageCoverage = numberOrNull(primary.images.observed.productImageCoverage);

  return <div className="experience-benchmark">
    <header className="benchmark-intro"><div><span>{ar ? "تحليل التجربة التنافسية" : "COMPETITIVE EXPERIENCE"}</span><h2>{ar ? "أين تتفوق تجربة الشراء لديك، وأين تخسر؟" : "Where does your shopping experience lead—and where does it lose?"}</h2><p>{ar ? "تُقاس شركتك والمنافسون من مقارنات المنتجات المقبولة بنفس نموذج الأدلة العامة. افتح المنهجية لمعرفة حدود كل قياس." : "Your company and rivals from accepted product comparisons use the same public-evidence scoring model. Open the methodology to see what each measurement can—and cannot—prove."}</p></div><div className="benchmark-position"><strong>{comparedDimensions ? `${wins}/${comparedDimensions}` : "—"}</strong><span>{comparedDimensions ? (ar ? "مقاييس تتصدرها" : "dimensions led") : (ar ? "لم تُقَس نتائج المنافسين" : "rival scores not assessed")}</span></div></header>

    <section className="benchmark-kpis" aria-label={ar ? "ملخص المقارنة" : "Benchmark summary"}>
      <article><span>{ar ? "استجابة الزحف" : "CRAWL RESPONSE"}</span><strong>{primaryResponse === null ? "—" : `${primaryResponse} ms`}</strong><small>{ar ? "مؤشر من موقع الزاحف، وليس سرعة مستخدم حقيقية" : "Crawler-location proxy, not real-user speed"}</small></article>
      <article><span>{ar ? "تغطية صور المنتجات" : "PRODUCT IMAGE COVERAGE"}</span><strong>{imageCoverage === null ? "—" : `${imageCoverage}%`}</strong><small>{ar ? `${primary.images.sampleSize} عنصراً تم تقييمه` : `${primary.images.sampleSize} items assessed`}</small></article>
      <article><span>{ar ? "المسار العام للدفع" : "PUBLIC CHECKOUT PATH"}</span><strong>{primary.purchasePath.minimumPublicSteps === null ? (ar ? "غير محسوم" : "Unknown") : `${primary.purchasePath.minimumPublicSteps} ${ar ? "خطوات على الأقل" : "min. steps"}`}</strong><small>{ar ? "تقدير من عناصر عامة، دون إجراء طلب" : "Observed controls only; no order placed"}</small></article>
      <article className="opportunity"><span>{ar ? "أكبر فرصة" : "BIGGEST OPPORTUNITY"}</span><strong>{opportunities[0] ? COPY[opportunities[0].key][ar ? "ar" : "en"] : (ar ? "لا توجد فجوة محسومة" : "No proven gap")}</strong><small>{opportunities[0] ? `${opportunities[0].gap} ${ar ? "نقطة خلف متوسط السوق" : "points behind market median"}` : (ar ? "البيانات المتاحة لا تثبت فجوة" : "Available evidence does not prove a gap")}</small></article>
    </section>

    <section className="benchmark-gap-chart">
      <header><div><span>{ar ? "أولويات السوق" : "MARKET PRIORITIES"}</span><h3>{ar ? "ما الذي يجب إصلاحه وما الذي يجب حمايته" : "What to fix—and what to protect"}</h3></div><p>{ar ? "مقارنة جاهزية من 100. النص والقيم هما المرجع؛ العلامات توضح الموضع فقط." : "Readiness comparison out of 100. Text and values are the source of truth; markers only show position."}</p></header>
      <div className="benchmark-gap-highlights">
        <div><span>{ar ? "أكبر فجوة مثبتة" : "LARGEST PROVEN GAP"}</span><strong>{opportunities[0] ? COPY[opportunities[0].key][ar ? "ar" : "en"] : (ar ? "لا توجد فجوة مثبتة" : "No proven gap")}</strong><small>{opportunities[0] ? (ar ? `${opportunities[0].gap} نقطة خلف متوسط السوق` : `${opportunities[0].gap} points behind market median`) : (ar ? "القيم المتاحة لا تثبت تأخراً" : "Available values do not prove a deficit")}</small></div>
        <div><span>{ar ? "أقوى ميزة مثبتة" : "STRONGEST PROVEN EDGE"}</span><strong>{advantages[0] ? COPY[advantages[0].key][ar ? "ar" : "en"] : (ar ? "لا توجد ميزة مثبتة" : "No proven edge")}</strong><small>{advantages[0] ? (ar ? `${advantages[0].delta} نقطة أمام متوسط السوق` : `${advantages[0].delta} points ahead of market median`) : (ar ? "القيم المتاحة لا تثبت تقدماً" : "Available values do not prove an advantage")}</small></div>
      </div>
      <div className="benchmark-track-legend" aria-hidden="true"><span className="you">{ar ? "أنت" : "You"}</span><span className="market">{ar ? "متوسط السوق" : "Market median"}</span><span className="leader">{ar ? "المتصدر المرصود" : "Observed leader"}</span></div>
      <div className="benchmark-scorecard">
        {positionedMarket.map((item) => {
          const copy = COPY[item.key];
          const status = item.band === "unknown"
            ? (ar ? "لم يتم قياس نتيجتك" : "Your score was not measured")
            : item.band === "level"
              ? (ar ? "عند متوسط السوق" : "At market median")
              : item.band === "behind"
                ? (ar ? `${Math.abs(item.delta || 0)} نقطة خلف متوسط السوق` : `${Math.abs(item.delta || 0)} points behind market median`)
                : (ar ? `${item.delta} نقطة أمام متوسط السوق` : `${item.delta} points ahead of market median`);
          return <article className={`benchmark-scorecard-row ${item.band}`} key={item.key}>
            <div className="benchmark-metric-label"><strong>{copy[ar ? "ar" : "en"]}</strong><small>{copy[ar ? "hintAr" : "hintEn"]}</small></div>
            <div className="benchmark-comparison">
              <div className="benchmark-track" aria-hidden="true">
                {item.median !== null && <i className="market" style={markerStyle(item.median)} />}
                {item.leader !== null && <i className="leader" style={markerStyle(item.leader)} />}
                {item.yours !== null && <i className="you" style={markerStyle(item.yours)} />}
              </div>
              <div className="benchmark-values"><span>{ar ? "أنت" : "You"} <b>{item.yours ?? "—"}</b></span><span>{ar ? "الوسط" : "Median"} <b>{item.median ?? "—"}</b></span><span>{ar ? "المتصدر" : "Leader"} <b>{item.leader ?? "—"}</b></span></div>
            </div>
            <div className="benchmark-decision"><strong>{status}</strong>{item.band === "behind" && <small>{benchmarkGapAction(item.key, primary[item.key as MetricKey].observed, ar)}</small>}</div>
          </article>;
        })}
      </div>
    </section>

    <div className="benchmark-analysis-grid">
      <section className="experience-map"><header><span>{ar ? "خريطة تجربة المنتج" : "PRODUCT EXPERIENCE MAP"}</span><h3>{ar ? "سهولة العثور مقابل اكتمال المعلومات" : "Findability vs. information completeness"}</h3></header><div className="experience-map-plot" role="img" aria-label={ar ? "مخطط يضع كل شركة حسب الوصول للمنتج واكتمال المعلومات" : "Plot of each company by product access and information completeness"}><span className="map-y-label">{ar ? "معلومات أكثر" : "More information"}</span><span className="map-x-label">{ar ? "وصول أسهل" : "Easier access"}</span>{domains.map((item, index) => { const x = score(item.productAccess); const y = score(item.information); if (x === null || y === null) return null; return <div className={`experience-point${item.domain === primaryDomain ? " primary" : ""}`} style={{ left: `${Math.max(4, Math.min(94, x))}%`, bottom: `${Math.max(8, Math.min(91, y))}%` }} title={`${item.domain}: ${x} access, ${y} information`} key={item.domain}><i>{index + 1}</i><b>{item.domain}</b></div>; })}</div><ol>{domains.map((item, index) => <li key={item.domain}><b>{index + 1}</b><span>{item.domain}</span><small>{score(item.productAccess) ?? "—"} / {score(item.information) ?? "—"}</small></li>)}</ol></section>

      <section className="response-comparison"><header><span>{ar ? "استجابة الصفحة" : "PAGE RESPONSE"}</span><h3>{ar ? "زمن استجابة HTML أثناء هذا الزحف" : "HTML response time in this crawl"}</h3><p>{ar ? "الأقل أفضل. يتأثر بموقع الزاحف وحالة الخادم ولا يمثل Core Web Vitals." : "Lower is better. This varies by crawler location and server state; it is not Core Web Vitals."}</p></header><div>{domains.map((item) => { const value = numberOrNull(item.response.observed.medianMs); return <article key={item.domain}><span>{item.domain}</span><i><b style={{ width: value === null ? "0" : `${Math.max(3, (value / maxResponse) * 100)}%` }} /></i><strong>{value === null ? "—" : `${value} ms`}</strong></article>; })}</div></section>
    </div>

    <section className="benchmark-domain-table"><header><span>{ar ? "لوحة السوق" : "MARKET SCOREBOARD"}</span><h3>{ar ? "كل شركة، نفس المقاييس" : "Every company, the same evidence model"}</h3><p>{ar ? "المنافسون هم النطاقات الأكثر ظهوراً في مقارنات المنتجات المقبولة لهذا التقرير." : "Rivals are the domains most represented in this report’s accepted product comparisons."}</p></header><div className="benchmark-table-scroll"><table><thead><tr><th>{ar ? "الشركة" : "Company"}</th>{SCORE_METRICS.map((key) => <th key={key}>{COPY[key][ar ? "ar" : "en"]}</th>)}</tr></thead><tbody>{domains.map((item) => <tr key={item.domain} className={item.assessmentStatus === "not-assessed" ? "not-assessed" : undefined}><th><div className="benchmark-company"><strong>{item.domain === primaryDomain && <span>{ar ? "أنت" : "YOU"}</span>}{item.domain}</strong>{assessedDate(item.observedAt, ar) && <small>{ar ? "تم التقييم" : "Assessed"} {assessedDate(item.observedAt, ar)}</small>}{item.assessmentStatus === "not-assessed" && <em title={item.assessmentReason}>{ar ? "لم يتم التقييم" : "Not assessed"}</em>}</div></th>{SCORE_METRICS.map((key) => { const value = score(item[key]); return <td key={key}><b className={value === null ? "unknown" : value >= 75 ? "strong" : value >= 50 ? "middle" : "weak"}>{value === null ? "—" : value}</b></td>; })}</tr>)}</tbody></table></div></section>

    <details className="benchmark-method"><summary>{ar ? "كيف تم حساب هذه المقارنة؟" : "How was this comparison calculated?"}</summary><p>{String(block.limitations || "")}</p>{METRICS.map((key) => <article key={key}><strong>{COPY[key][ar ? "ar" : "en"]}</strong><p>{primary[key].formula}</p><span>{ar ? "حجم عينة شركتك" : "Your sample"}: {primary[key].sampleSize}</span>{primary[key].sourceUrls[0] && <a href={primary[key].sourceUrls[0]} target="_blank" rel="noreferrer">{ar ? "افتح المصدر ↗" : "Open source ↗"}</a>}</article>)}</details>
  </div>;
}
