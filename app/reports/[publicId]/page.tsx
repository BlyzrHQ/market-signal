"use client";

import Link from "next/link";
import { KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProductDesignLab } from "../../components/product-design-lab";
import { ExperienceBenchmark } from "../../components/experience-benchmark";
import { reportCoverage, type ReportCoverageEvent } from "../../lib/report-coverage";
import { jsonResponseErrorMessage, readJsonResponse } from "../../lib/json-response";

type Block = { type: string; id: string } & Record<string, unknown>;
type ReportEvent = ReportCoverageEvent;
type View = "overview" | "competitors" | "products" | "ads" | "evidence";
type StoredPayload = { ok: boolean; error?: string; report?: { run: { publicId: string; primaryDomain: string; locale: "en" | "ar"; status: string; createdAt: string; updatedAt: string; errorMessage: string; productPlan: string; productLimit: number }; events: ReportEvent[]; document: { document?: { version: "1"; generatedAt: string; blocks: Block[] }; marketBrief?: Record<string, unknown> } | null; documentSchemaVersion: number; primaryProducts?: { authoritative: boolean; totalCount: number; products: Array<Record<string, unknown>>; truncated: boolean } } };

const VIEWS: View[] = ["competitors", "products", "overview"];
const VIEW_LABELS: Record<View, { en: string; ar: string }> = {
  overview: { en: "Benchmark", ar: "المقارنة" }, competitors: { en: "Competitors", ar: "المنافسون" },
  products: { en: "Products", ar: "المنتجات" }, ads: { en: "Ads", ar: "الإعلانات" },
  evidence: { en: "Evidence & Method", ar: "الأدلة والمنهجية" },
};

function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown) { return Array.isArray(value) ? value : []; }
function numeric(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function repairEncoding(value: string) {
  if (!/(?:Ã|Â|Ø|Ù|â)/.test(value)) return value;
  try {
    const bytes = Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return repaired.includes("�") ? value : repaired;
  } catch { return value; }
}
function display(value: unknown, fallback = "") {
  const clean = repairEncoding(typeof value === "string" ? value : "").replace(/&ndash;/g, "–").replace(/&amp;/g, "&").replace(/â|â/g, '"').trim();
  return clean || fallback;
}
function safeUrl(value: unknown) { const url = display(value); return /^https?:\/\/[^\s]+$/i.test(url) ? url : ""; }
function slug(value: unknown) { return display(value, "item").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "item"; }
function viewFromLocation(views: View[] = VIEWS): View { const value = new URLSearchParams(window.location.search).get("view"); return views.includes(value as View) ? value as View : views[0] || "overview"; }
function viewHref(view: View, anchor = "") { return `?view=${view}${anchor ? `#${anchor}` : ""}`; }
function statusTone(status: string) { return status === "verified-active" ? "observed" : status === "access-limited" ? "limited" : status === "no-verified-result" ? "unavailable" : "inferred"; }
function scrollToReportHash() {
  const raw = window.location.hash.slice(1); if (!raw) return;
  let id = raw; try { id = decodeURIComponent(raw); } catch { /* Keep a malformed but harmless literal fragment. */ }
  const target = document.getElementById(id);
  const group = target?.closest("details");
  if (group instanceof HTMLDetailsElement) group.open = true;
  target?.scrollIntoView({ block: "start" });
}

function safeAdDestination(value: unknown) {
  const href = safeUrl(value); if (!href) return "";
  try {
    const url = new URL(href); const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const privateHost = host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1" || /^0\./.test(host) || /^10\./.test(host) || /^127\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
    if (url.username || url.password || privateHost) return "";
    return url.toString();
  } catch { return ""; }
}
function safeMetaMedia(value: unknown) {
  const href = safeUrl(value); if (!href) return "";
  try { const url = new URL(href); const host = url.hostname.toLowerCase(); return url.protocol === "https:" && ["fbcdn.net", "fbsbx.com", "facebook.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ? url.toString() : ""; } catch { return ""; }
}
function safeMetaRecord(value: unknown, id: unknown) {
  const href = safeUrl(value);
  if (href) { try { const url = new URL(href); const host = url.hostname.toLowerCase().replace(/^www\./, ""); if (host === "facebook.com" && url.pathname.toLowerCase().startsWith("/ads/library")) return url.toString(); } catch { /* Use the canonical record URL below. */ } }
  const recordId = display(id); return /^\d+$/.test(recordId) ? `https://www.facebook.com/ads/library/?id=${recordId}` : "";
}
function urlHost(value: unknown) { const href = safeAdDestination(value); if (!href) return ""; try { return new URL(href).hostname.replace(/^www\./, ""); } catch { return ""; } }

function AdCreativeCard({ concept, ar }: { concept: Record<string, unknown>; ar: boolean }) {
  const [mediaFailed, setMediaFailed] = useState(false);
  const mediaUrl = safeMetaMedia(concept.mediaUrl); const destinationUrl = safeAdDestination(concept.destinationUrl); const evidenceUrl = safeMetaRecord(concept.evidenceUrl, concept.id);
  const headline = display(concept.headline, display(concept.caption, ar ? "إعلان متحقق" : "Verified creative"));
  const startDate = display(concept.startDate); const stopDate = display(concept.stopDate);
  const platforms = list(concept.platforms).map((item) => display(item)).filter(Boolean).join(" · ");
  return <article className="ad-creative-card">
    <div className={`ad-creative-media${mediaUrl ? " has-media" : ""}${mediaFailed ? " media-missing" : ""}`}><span>{ar ? "الصورة غير متاحة — النسخ الإعلاني متحقق" : "Media unavailable — verified ad copy is shown below"}</span>{mediaUrl && !mediaFailed && <img src={mediaUrl} alt={headline} loading="lazy" onError={() => setMediaFailed(true)} />}</div>
    <div className="ad-creative-copy"><span>{display(concept.callToAction, ar ? "نسخة الإعلان" : "AD CREATIVE")}</span><strong>{headline}</strong>{display(concept.message) && <p>{display(concept.message)}</p>}{display(concept.description) && <small>{display(concept.description)}</small>}</div>
    <dl className="ad-creative-meta"><div><dt>{ar ? "التوصيل" : "DELIVERY"}</dt><dd>{startDate || (ar ? "غير محفوظ" : "Not saved")} → {stopDate || (ar ? "نشط عند الرصد" : "active when observed")}</dd></div><div><dt>{ar ? "المنصات" : "PLACEMENTS"}</dt><dd>{numeric(concept.placementCount) || 1} {platforms ? `· ${platforms}` : ""}</dd></div><div><dt>{ar ? "الوجهة" : "DESTINATION"}</dt><dd>{urlHost(destinationUrl) || (ar ? "غير متاح" : "Not available")}</dd></div></dl>
    <div className="ad-creative-actions">{evidenceUrl && <a href={evidenceUrl} target="_blank" rel="noreferrer">{ar ? "افتح سجل الإعلان ↗" : "Open ad record ↗"}</a>}{destinationUrl && <a href={destinationUrl} target="_blank" rel="noreferrer">{ar ? "افتح الوجهة ↗" : "Open destination ↗"}</a>}</div>
  </article>;
}

function ReportWorkspace({ blocks, primaryProducts, publicId, primaryDomain, observedAt, reportStatus, reportEvents, ar, onToggleLocale }: { blocks: Block[]; primaryProducts?: { authoritative: boolean; totalCount: number; products: Array<Record<string, unknown>>; truncated: boolean }; publicId: string; primaryDomain: string; observedAt: string; reportStatus: string; reportEvents: ReportEvent[]; ar: boolean; onToggleLocale: () => void }) {
  const domainStatus = blocks.find((block) => block.type === "domain-status" && ["parked", "unavailable"].includes(display(block.status).toLowerCase()));
  const domainState = display(domainStatus?.status).toLowerCase();
  const terminalDomain = Boolean(domainStatus);
  const parked = domainState === "parked";
  const unavailableDomain = domainState === "unavailable";
  const activeViews = useMemo<View[]>(() => terminalDomain ? ["overview"] : VIEWS, [terminalDomain]);
  const [view, setView] = useState<View>(VIEWS[0]);
  const [compactNav, setCompactNav] = useState(false);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => { const sync = () => { const requested = new URLSearchParams(window.location.search).get("view"); const next = viewFromLocation(activeViews); setView(next); if (!activeViews.includes(requested as View)) { const url = new URL(window.location.href); url.searchParams.set("view", next); url.hash = ""; window.history.replaceState({}, "", url); } }; sync(); window.addEventListener("popstate", sync); return () => window.removeEventListener("popstate", sync); }, [activeViews]);
  useEffect(() => { const media = window.matchMedia("(max-width: 1023px)"); const sync = () => setCompactNav(media.matches); sync(); media.addEventListener("change", sync); return () => media.removeEventListener("change", sync); }, []);
  useEffect(() => { const frame = window.requestAnimationFrame(scrollToReportHash); window.addEventListener("hashchange", scrollToReportHash); return () => { window.cancelAnimationFrame(frame); window.removeEventListener("hashchange", scrollToReportHash); }; }, [view, blocks]);
  useEffect(() => { if (compactNav) tabs.current[activeViews.indexOf(view)]?.scrollIntoView({ inline: "nearest", block: "nearest" }); }, [activeViews, compactNav, view]);
  useEffect(() => {
    let printOpened: HTMLDetailsElement[] = [];
    const expandPrintEvidence = () => { printOpened = Array.from(document.querySelectorAll<HTMLDetailsElement>(".comparison-detail-disclosure:not([open]), .product-match-details:not([open]), .evidence-source-group:not([open])")); printOpened.forEach((detail) => { detail.open = true; }); };
    const restorePrintEvidence = () => { printOpened.forEach((detail) => { detail.open = false; }); printOpened = []; };
    window.addEventListener("beforeprint", expandPrintEvidence); window.addEventListener("afterprint", restorePrintEvidence);
    return () => { window.removeEventListener("beforeprint", expandPrintEvidence); window.removeEventListener("afterprint", restorePrintEvidence); };
  }, []);
  const selectView = (next: View, replace = false, hash = "") => {
    const url = new URL(window.location.href); url.searchParams.set("view", next); url.hash = hash;
    window.history[replace ? "replaceState" : "pushState"]({}, "", url); setView(next);
    if (!hash) window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forwardKey = compactNav ? (ar ? "ArrowLeft" : "ArrowRight") : "ArrowDown"; const backwardKey = compactNav ? (ar ? "ArrowRight" : "ArrowLeft") : "ArrowUp";
    const next = event.key === forwardKey ? (index + 1) % activeViews.length : event.key === backwardKey ? (index - 1 + activeViews.length) % activeViews.length : event.key === "Home" ? 0 : event.key === "End" ? activeViews.length - 1 : -1;
    if (next < 0) return; event.preventDefault(); tabs.current[next]?.focus(); selectView(activeViews[next]);
  };
  const onWorkspaceClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href^="?view="]'); if (!anchor) return;
    const url = new URL(anchor.href); const next = url.searchParams.get("view") as View; if (!activeViews.includes(next)) return;
    event.preventDefault(); selectView(next, false, url.hash);
  };

  const competitors = useMemo(() => blocks.filter((block) => block.type === "competitor").sort((a, b) => numeric(b.verificationScore) - numeric(a.verificationScore)), [blocks]);
  const comparison = blocks.find((block) => block.type === "product-comparison");
  const legacyUngatedMatchCount = useMemo(() => list(comparison?.rows).reduce((total, row) => total + list(object(row).matches).filter((match) => typeof object(object(match).publication).priceEligible !== "boolean").length, 0), [comparison]);
  const battles = useMemo(() => list(comparison?.rows).flatMap((row, rowIndex) => {
    const item = object(row); const primary = object(item.primary);
    return list(item.matches).flatMap((match, matchIndex) => { const candidate = object(match); const rival = object(candidate.product); return object(candidate.publication).priceEligible === true && rival.name ? [{ primary, rival, match: candidate, key: `${rowIndex}-${matchIndex}` }] : []; });
  }), [comparison]);
  const [authoritativeMatchSummary, setAuthoritativeMatchSummary] = useState<{ publicId: string; totalCount: number; domainCounts: Record<string, number> } | null>(null);
  const receiveAuthoritativeMatchSummary = useCallback((summary: { totalCount: number; domainCounts: Record<string, number> }) => setAuthoritativeMatchSummary({ publicId, ...summary }), [publicId]);
  useEffect(() => {
    let current = true;
    fetch(`/api/reports/${publicId}/matches?limit=1`, { headers: { accept: "application/json" } })
      .then((response) => readJsonResponse<{ ok: boolean; page?: { authoritative: true; totalCount: number; domainCounts: Record<string, number> } }>(response, "Saved report match totals"))
      .then((body) => { if (current && body.ok && body.page?.authoritative) setAuthoritativeMatchSummary({ publicId, totalCount: body.page.totalCount, domainCounts: body.page.domainCounts || {} }); })
      .catch(() => { /* The compact report counts remain the explicit fallback. */ });
    return () => { current = false; };
  }, [publicId]);
  const currentMatchSummary = authoritativeMatchSummary?.publicId === publicId ? authoritativeMatchSummary : null;
  const productMatchTotal = currentMatchSummary?.totalCount ?? battles.length;
  const adBlock = blocks.find((block) => block.type === "ad-intelligence");
  const adCompanies = list(adBlock?.companies).map(object);
  const evidence = blocks.filter((block) => block.type === "evidence");
  const gaps = blocks.filter((block) => block.type === "gap");
  const domainAlternatives = list(domainStatus?.alternatives).map(object);
  const coverage = blocks.filter((block) => block.type === "coverage");
  const profile = blocks.find((block) => block.type === "market-profile");
  const experienceBenchmark = blocks.find((block) => block.type === "experience-benchmark");
  const activeAds = adCompanies.reduce((total, company) => total + list(company.platforms).filter((platform) => display(object(platform).status) === "verified-active").length, 0);
  const adPlatforms = adCompanies.flatMap((company) => list(company.platforms).map(object));
  const limitedAdChecks = adPlatforms.filter((platform) => display(platform.status) === "access-limited").length;
  const officialAdSearches = adPlatforms.filter((platform) => safeUrl(platform.searchUrl)).length;
  const adRegion = display(adBlock?.regionCode, display(profile?.region, ar ? "السوق المحدد" : "selected market"));
  const coverageStatus = reportCoverage(reportStatus, reportEvents, ar);
  const productAnchor = (domain: unknown) => `rival-${slug(domain)}`;
  const competitorAnchor = (domain: unknown) => `competitor-${slug(domain)}`;
  const adAnchor = (domain: unknown) => `ad-${slug(domain)}`;
  const evidenceAnchor = (domain: unknown) => `evidence-${slug(domain)}`;

  return <div className="intelligence-workspace report-dashboard-shell" onClick={onWorkspaceClick}>
    <aside className="report-dashboard-sidebar">
      <Link className="dashboard-brand" href="/">Market Signal</Link>
      <section className={`dashboard-report-identity ${reportStatus === "limited" ? "partial" : "ready"}`} aria-label={ar ? "حالة تغطية التقرير" : "Report coverage status"}>
        <div><span>{ar ? "نطاق التقرير" : "REPORT SCOPE"}</span><b>{coverageStatus.label}</b></div>
        <strong dir="auto"><i aria-hidden="true" />{primaryDomain}</strong>
        <p>{coverageStatus.title}</p>
        <small>{coverageStatus.detail}</small>
        <time dateTime={observedAt}>{ar ? "حُدث" : "Updated"} {new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</time>
      </section>
      <nav className="workspace-tabs" role="tablist" aria-orientation={compactNav ? "horizontal" : "vertical"} aria-label={ar ? "أقسام التقرير" : "Report sections"}>
        {activeViews.map((item, index) => <button key={item} ref={(node) => { tabs.current[index] = node; }} id={`tab-${item}`} type="button" role="tab" aria-selected={view === item} aria-controls={`panel-${item}`} tabIndex={view === item ? 0 : -1} onClick={() => selectView(item)} onKeyDown={(event) => onTabKey(event, index)}>{VIEW_LABELS[item][ar ? "ar" : "en"]}{item === "competitors" && <b>{competitors.length}</b>}{item === "products" && <b>{productMatchTotal}</b>}</button>)}
      </nav>
    </aside>
    <div className="report-dashboard-main">
      <header className="report-route-header"><div className="dashboard-view-title"><span>{ar ? "معلومات السوق" : "MARKET INTELLIGENCE"}</span><b>{VIEW_LABELS[view][ar ? "ar" : "en"]}</b></div><div className={`report-route-meta ${reportStatus === "limited" ? "partial" : "ready"}`} title={coverageStatus.detail}><span>{coverageStatus.label}</span><time>{ar ? "لوحظ" : "Observed"} {new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</time></div><div className="report-route-actions"><button type="button" onClick={onToggleLocale} aria-label={ar ? "Switch to English" : "التبديل إلى العربية"}>{ar ? "EN" : "ع"}</button><Link href="/">{ar ? "تقرير جديد" : "New report"}</Link></div></header>
      <section className="workspace-panel" id={`panel-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`} tabIndex={0}>
      {reportStatus === "limited" && <aside className="report-coverage-notice" role="status"><div><span>{coverageStatus.label}</span><strong>{coverageStatus.title}</strong></div><p>{coverageStatus.detail}</p></aside>}
      {view === "overview" && <>
        {terminalDomain && <header className="panel-intro"><div><span>{ar ? "حالة النطاق" : "DOMAIN STATUS"}</span><h2>{parked ? (ar ? "هذا النطاق معروض للبيع" : "This domain is parked, not an active company site") : (ar ? "تعذر الوصول إلى موقع عام على هذا النطاق" : "No public website response was available for this domain")}</h2><p>{display(domainStatus?.explanation, parked ? (ar ? "يتجه النطاق إلى خدمة عامة لبيع النطاقات، لذلك لم تُشغّل مراحل المنافسين والمنتجات والإعلانات." : "The submitted domain redirects to a public domain-for-sale service. Competitor, product, and advertising analysis did not run.") : (ar ? "لم يعد العنوان العام باستجابة شبكة بعد محاولتين محدودتين، لذلك لم يبدأ تحليل السوق." : "The public HTTPS address returned no network response after two bounded attempts, so market analysis did not start."))}</p></div><time>{ar ? "لوحظ" : "Observed"}<b>{new Date(observedAt).toLocaleString(ar ? "ar" : "en")}</b></time></header>}
        {terminalDomain && <div className="parked-domain-state"><div><span className="truth-pill limited">{ar ? "تقرير محدود" : "LIMITED REPORT"}</span><strong>{ar ? "لم نفحص المنافسين أو المنتجات أو الإعلانات" : "Competitors, products, and ads were not checked"}</strong><p>{ar ? "هذه ليست نتيجة صفرية. تم تخطي تلك المراحل لأن نطاق الشركة لم يكن متاحاً للتحليل." : parked ? "This is not a zero-result report. Those phases were intentionally skipped because there is no attributable company storefront at the submitted domain." : "This is not a zero-result report. Those phases were intentionally skipped because the submitted address did not return a public website response."}</p><div className="entity-links">{parked && safeUrl(domainStatus?.evidenceUrl) && <a href={safeUrl(domainStatus?.evidenceUrl)} target="_blank" rel="noreferrer">{ar ? "افتح دليل النطاق ↗" : "Open parking evidence ↗"}</a>}{unavailableDomain && safeUrl(domainStatus?.attemptedUrl) && <a href={safeUrl(domainStatus?.attemptedUrl)} target="_blank" rel="noreferrer">{ar ? "افتح العنوان الذي تمت محاولته ↗" : "Open attempted address ↗"}</a>}<Link href="/">{ar ? "تحقق من النطاق أو حاول مرة أخرى" : "Check the domain or try again"}</Link></div></div>{parked && domainAlternatives.length > 0 && <section><span>{ar ? "نطاقات محتملة — الهوية غير متحققة" : "POSSIBLE DOMAINS — IDENTITY NOT VERIFIED"}</span><p>{ar ? "استخدم أحدها فقط إذا أكدت أنه يخص شركتك." : "Use one only if you confirm it belongs to your company."}</p>{domainAlternatives.map((alternative) => <a href={safeUrl(alternative.sourceUrl)} target="_blank" rel="noreferrer" key={display(alternative.domain)}><strong>{display(alternative.domain)}</strong><small>{display(alternative.reason, "Unverified name-related search result")}</small></a>)}</section>}</div>}
        {!terminalDomain && <ExperienceBenchmark block={experienceBenchmark} primaryDomain={primaryDomain} ar={ar} />}
      </>}

      {view === "competitors" && <>
        <header className="panel-intro compact"><div><span>{ar ? "خريطة المنافسين" : "RIVAL MAP"}</span><h2>{ar ? "من ينافسك على نفس العميل؟" : "Who competes for the same customer?"}</h2><p>{ar ? "تم تضمين الشركات التي اجتازت التحقق من الفئة والسوق. تشابه المنتجات يقوي العلاقة." : "Included companies passed category and market verification. Product overlap strengthens the relationship."}</p></div></header>
        <div className="panel-metrics"><div><strong>{competitors.length}</strong><span>{ar ? "منافسون متحققون" : "verified competitors"}</span></div><div><strong>{competitors.filter((item) => item.hasProductOverlap).length}</strong><span>{ar ? "بتداخل منتجات" : "with product overlap"}</span></div><div><strong>{competitors.filter((item) => display(item.confidence).toLowerCase() === "high").length}</strong><span>{ar ? "ثقة عالية" : "high confidence"}</span></div></div>
        <div className="competitor-workspace-list">{competitors.map((competitor, index) => { const domain = display(competitor.domain); const rivalBattles = battles.filter((battle) => display(battle.match.domain || battle.rival.domain) === domain); const rivalBattleCount = currentMatchSummary?.domainCounts?.[domain] ?? rivalBattles.length; return <article id={competitorAnchor(domain)} key={competitor.id}><header><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{display(competitor.companyName || domain, domain)}</h3><p>{domain}</p></div><b>{numeric(competitor.verificationScore)}/100</b></header><p className="rival-reason">{display(competitor.reason || competitor.description, ar ? "تم التحقق من تداخل السوق من المصادر العامة." : "Public sources verify market overlap.")}</p><div className="rival-facts"><span>{display(competitor.relationship, "direct")}</span><span>{display(competitor.confidence, "Limited")} {ar ? "الثقة" : "confidence"}</span><span>{numeric(competitor.productCount)} {ar ? "منتجاً مرصوداً" : "products observed"}</span></div><div className="entity-links"><a href={viewHref("products", productAnchor(domain))}>{ar ? `${rivalBattleCount} مقارنة منتجات` : `${rivalBattleCount} product battles`}</a>{safeUrl(competitor.websiteSourceUrl || competitor.discoverySourceUrl) && <a href={safeUrl(competitor.websiteSourceUrl || competitor.discoverySourceUrl)} target="_blank" rel="noreferrer">{ar ? "موقع المنافس ↗" : "Competitor site ↗"}</a>}</div></article>; })}</div>
        {!competitors.length && <div className="truth-state limited"><strong>{ar ? "لم يتم التحقق من منافس" : "No competitor was verified"}</strong><p>{ar ? "هذا نقص في التغطية، وليس دليلاً على عدم وجود منافسين." : "This is a coverage gap, not proof that no competitors exist."}</p></div>}
      </>}

      {view === "products" && <>
        {legacyUngatedMatchCount > 0 && <aside className="report-coverage-notice" role="status"><div><span>{ar ? "تقرير قديم" : "LEGACY REPORT"}</span><strong>{ar ? "تحتاج مقارنات الأسعار المحفوظة إلى إعادة التحقق" : "Saved price comparisons need revalidation"}</strong></div><p>{ar ? "أُنشئ هذا التقرير قبل بوابة التحقق الحالية للسوق والعملة. أخفينا صفوفه القديمة بدلاً من عرض أسعار قد تكون من سوق مختلف. شغّل تقريراً جديداً للحصول على مقارنات متحققة." : "This report predates the current market-and-currency validation gate. Its older rows are hidden rather than showing prices that may belong to another market. Run a new report for verified comparisons."}</p><Link href="/">{ar ? "شغّل تقريراً جديداً" : "Run a new report"}</Link></aside>}
        <ProductDesignLab key={publicId} comparison={comparison} battles={battles} primaryProducts={primaryProducts} publicId={publicId} authoritativeMatchTotal={productMatchTotal || undefined} onAuthoritativeSummary={receiveAuthoritativeMatchSummary} primaryDomain={primaryDomain} observedAt={observedAt} ar={ar} />
      </>}

      {view === "ads" && <>
        <header className="panel-intro compact"><div><span>{ar ? "مراقبة الإعلانات" : "AD WATCH"}</span><h2>{ar ? "من يعلن فعلاً، وماذا تقول إعلاناته؟" : "Who is verifiably advertising, and what are their ads saying?"}</h2><p>{display(adBlock?.limitation, ar ? "تختلف تغطية مكتبات الإعلانات حسب السوق والمنصة." : "Ad-library coverage varies by market and platform.")}</p></div></header>
        <div className="panel-metrics"><div><strong>{adCompanies.length}</strong><span>{ar ? "شركات تم فحصها" : "companies checked"}</span></div><div><strong>{activeAds}</strong><span>{ar ? "إشارات نشاط متحققة" : "verified active signals"}</span></div><div><strong>{limitedAdChecks}</strong><span>{ar ? "فحوص محدودة الوصول" : "access-limited checks"}</span></div></div>
        {activeAds > 0 && <div className="ad-workspace-list">{adCompanies.map((company) => { const domain = display(company.domain); const platforms = list(company.platforms).map(object); const comparisonToPrimary = object(company.comparisonToPrimary); return <article id={adAnchor(domain)} key={domain}><header><div><span>{ar ? "المعلن" : "ADVERTISER"}</span><h3>{display(company.brand || domain, domain)}</h3><p>{domain}</p></div><a href={viewHref("competitors", competitorAnchor(domain))}>{domain === primaryDomain ? (ar ? "شركتك" : "Your company") : (ar ? "ملف المنافس" : "Rival dossier")}</a></header><p>{display(company.summary)}</p>{display(comparisonToPrimary.headline) && <div className="ad-vs-you"><span>{ar ? "مقارنة بشركتك" : "VS. YOU"}</span><strong>{display(comparisonToPrimary.headline)}</strong><p>{display(comparisonToPrimary.implication)}</p></div>}<div className="platform-checks">{platforms.map((platform) => { const status = display(platform.status, "access-limited"); return <section className={statusTone(status)} key={display(platform.platform)}><div><span>{display(platform.platform)}</span><b>{status === "verified-active" ? `${numeric(platform.activeCreativeCount)} ${ar ? "سجل نشط" : "active records"}` : status.replace(/-/g, " ")}</b></div><p>{display(platform.message)}</p><div className="entity-links">{safeUrl(platform.searchUrl) && <a href={safeUrl(platform.searchUrl)} target="_blank" rel="noreferrer">{ar ? "افتح البحث الرسمي ↗" : "Open official search ↗"}</a>}{list(platform.evidenceUrls).map((value) => safeUrl(value)).filter(Boolean).map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={`${url}-${index}`}>{ar ? `سجل الإعلان ${index + 1} ↗` : `Ad record ${index + 1} ↗`}</a>)}</div></section>; })}</div>{platforms.filter((platform) => display(platform.status) === "verified-active" && list(platform.creativeConcepts).length).map((platform) => { const concepts = list(platform.creativeConcepts).map(object); const recordCount = numeric(platform.activeCreativeCount); return <section className="verified-creative-section" key={`${domain}-${display(platform.platform)}`}><header><div><span>{ar ? "إعلانات متحققة" : "VERIFIED CREATIVE"}</span><strong>{platform.activeCreativeCountIsLowerBound ? (ar ? "على الأقل " : "At least ") : ""}{recordCount} {ar ? "سجل نشط مجمّع في" : "active records grouped into"} {concepts.length} {ar ? "أفكار إعلانية" : "creative concepts"}</strong></div>{safeUrl(platform.attributionUrl) && <a href={safeUrl(platform.attributionUrl)} target="_blank" rel="noreferrer">{display(platform.attributionLabel, ar ? "صفحة المعلن ↗" : "Advertiser Page ↗")}</a>}</header><div className="ad-creative-feed">{concepts.slice(0, 6).map((concept, index) => <AdCreativeCard concept={concept} ar={ar} key={display(concept.id, `${domain}-${index}`)} />)}</div>{(numeric(platform.discardedRecordCount) > 0 || numeric(platform.inactiveRecordCount) > 0) && <p className="ad-coverage-note">{numeric(platform.discardedRecordCount)} {ar ? "سجلات من صفحات أخرى مستبعدة" : "cross-Page records discarded"} · {numeric(platform.inactiveRecordCount)} {ar ? "سجلات قديمة مستبعدة" : "stale records excluded"}</p>}</section>; })}<div className="ad-action"><span>{ar ? "الإجراء التالي" : "NEXT ACTION"}</span><strong>{display(company.recommendedAction, ar ? "أعد الفحص قبل استخلاص نتيجة." : "Recheck before drawing a conclusion.")}</strong></div></article>; })}</div>}
        {activeAds === 0 && adCompanies.length > 0 && <section className="ad-verification-queue"><header><span>{ar ? "لم يتم التحقق من إعلان نشط" : "NOTHING ACTIVE WAS VERIFIED"}</span><h3>{ar ? "هذه فجوة تغطية، وليست دليلاً على عدم وجود إعلانات." : "This is a coverage result, not proof that these companies are not advertising; no verified result is not proof of zero ads."}</h3><p>{ar ? `تم تجهيز ${officialAdSearches} عملية بحث رسمية في ${adRegion}. افتحها للتحقق الآن، ثم أعد تشغيل التقرير لمراقبة التغيير.` : `${officialAdSearches} official searches are ready for ${adRegion}. Open them to verify now, then rerun the report to monitor change.`}</p></header><div>{adCompanies.map((company) => { const domain = display(company.domain); return <article id={adAnchor(domain)} key={domain}><div className="ad-queue-company"><span>{ar ? "للمراجعة" : "TO REVIEW"}</span><strong>{display(company.brand || domain, domain)}</strong><small>{domain}</small></div><div className="ad-queue-checks">{list(company.platforms).map(object).map((platform) => <section key={display(platform.platform)}><div><b>{display(platform.platform)}</b><span className={`truth-pill ${statusTone(display(platform.status))}`}>{display(platform.status).replace(/-/g, " ")}</span></div>{display(platform.exactPageName || platform.exactPageId) && <small>{ar ? "هوية الصفحة" : "Resolved identity"}: {display(platform.exactPageName)} {display(platform.exactPageId) && `· ${display(platform.exactPageId)}`}</small>}<p>{display(platform.message, ar ? "لم يتم حفظ سبب التغطية." : "No coverage reason was saved.")}</p>{safeUrl(platform.searchUrl) && <a href={safeUrl(platform.searchUrl)} target="_blank" rel="noreferrer">{ar ? `افتح بحث ${display(platform.platform)} ↗` : `Open ${display(platform.platform)} search ↗`}</a>}</section>)}</div><footer><span>{ar ? "الخطوة التالية" : "NEXT CHECK"}</span><strong>{display(company.recommendedAction, ar ? "راجع عمليات البحث الرسمية ثم أعد تشغيل التقرير." : "Review the official searches, then rerun this report.")}</strong></footer></article>; })}</div></section>}
        {!adCompanies.length && <div className="truth-state unavailable"><strong>{ar ? "تغطية الإعلانات غير متاحة" : "Ad coverage is unavailable"}</strong><p>{ar ? "لم يتم حفظ نتيجة مكتبة لهذا التشغيل. هذا لا يعني أن الشركات لا تعلن." : "No library result was saved for this run. This does not mean the companies do not advertise."}</p></div>}
      </>}

      {view === "evidence" && <>
        <header className="panel-intro compact"><div><span>{ar ? "الأدلة والحدود" : "SOURCES & LIMITS"}</span><h2>{ar ? "ما الذي يدعم قرارات هذا التقرير، وما الذي لا يثبته؟" : "What supports this report's decisions—and what does it not prove?"}</h2><p>{ar ? "تظل الحقائق والاستنتاجات وفجوات التغطية منفصلة. افتح مجموعة فقط عندما تريد التحقق من مصدر." : "Facts, interpretations, and coverage gaps stay separate. Open a group only when you need to verify a source."}</p></div></header>
        <div className="truth-legend"><div className="observed"><span>{ar ? "مرصود" : "OBSERVED"}</span><p>{ar ? "ظهر مباشرة في مصدر عام." : "Directly present in a public source."}</p></div><div className="inferred"><span>{ar ? "مستنتج" : "INFERRED"}</span><p>{ar ? "تفسير مبني على أدلة مرتبطة." : "An interpretation based on linked evidence."}</p></div><div className="limited"><span>{ar ? "محدود" : "LIMITED"}</span><p>{ar ? "تم الفحص لكن التغطية غير مكتملة." : "A check ran, but coverage is incomplete."}</p></div><div className="unavailable"><span>{ar ? "غير متاح" : "UNAVAILABLE"}</span><p>{ar ? "تعذر الوصول إلى المصدر أو الموفر." : "The source or provider could not be accessed."}</p></div></div>
        <div className="panel-metrics evidence-metrics"><div><strong>{evidence.length}</strong><span>{ar ? "ادعاءات مرتبطة بالمصدر" : "source-linked claims"}</span></div><div><strong>{evidence.filter((item) => display(item.claimType).toLowerCase() === "observed").length}</strong><span>{ar ? "مرصودة" : "observed"}</span></div><div><strong>{evidence.filter((item) => display(item.claimType).toLowerCase() === "inferred").length}</strong><span>{ar ? "مستنتجة" : "inferred"}</span></div><div><strong>{gaps.length}</strong><span>{ar ? "فجوات معلنة" : "open gaps"}</span></div></div>
        <div className="evidence-groups">{[primaryDomain, ...competitors.map((item) => display(item.domain))].filter((domain, index, all) => domain && all.indexOf(domain) === index).map((domain) => { const claims = evidence.filter((claim) => { try { return new URL(safeUrl(claim.sourceUrl)).hostname.replace(/^www\./, "") === domain.replace(/^www\./, ""); } catch { return false; } }); return <details className="evidence-source-group" id={evidenceAnchor(domain)} key={domain}><summary><div><span>{domain === primaryDomain ? (ar ? "شركتك" : "YOUR COMPANY") : (ar ? "منافس" : "COMPETITOR")}</span><h3>{domain}</h3></div><b>{claims.length} {ar ? "مصدر" : "claims"}</b></summary>{claims.length ? <div>{claims.map((claim) => <article key={claim.id}><span className={`truth-pill ${display(claim.claimType, "observed").toLowerCase()}`}>{display(claim.claimType, ar ? "مرصود" : "Observed")}</span><p dir="auto">{display(claim.text)}</p><footer><b>{display(claim.confidence, ar ? "ثقة محدودة" : "Limited confidence")}</b><a href={safeUrl(claim.sourceUrl)} target="_blank" rel="noreferrer">{ar ? "افتح المصدر ↗" : "Open source ↗"}</a></footer></article>)}</div> : <p className="group-empty">{ar ? "لا توجد ادعاءات محفوظة لهذا النطاق." : "No saved claims for this domain."}</p>}</details>; })}</div>
        <div className="coverage-list"><h3>{ar ? "تغطية الزحف" : "Crawl coverage"}</h3>{coverage.map((item) => <article key={item.id}><strong>{display(item.domain)}</strong><span>{numeric(item.pagesFetched)}/{numeric(item.pagesRequested)} {ar ? "صفحات" : "pages"}</span><p>{list(item.gaps).map((gap) => display(gap)).filter(Boolean).join(" · ") || (ar ? "لم تُحفظ فجوة لهذا النطاق." : "No crawl gap was saved for this domain.")}</p></article>)}</div>
        <div className="coverage-list gaps"><h3>{ar ? "فجوات التحقيق" : "Investigation gaps"}</h3>{gaps.slice(0, 30).map((gap) => <article key={gap.id}><strong>{display(gap.domain, ar ? "مصدر عام" : "Public source")}</strong><span>{display(gap.observedAt) && new Date(display(gap.observedAt)).toLocaleDateString(ar ? "ar" : "en")}</span><p>{display(gap.reason)}</p>{safeUrl(gap.url) && <a href={safeUrl(gap.url)} target="_blank" rel="noreferrer">{ar ? "افتح المصدر ↗" : "Open source ↗"}</a>}</article>)}</div>
        <section className="plain-method" id="method"><header><span>{ar ? "كيف أُعد هذا التقرير" : "HOW THIS REPORT WAS ASSEMBLED"}</span><h3>{ar ? "طريقة واضحة، من دون تفاصيل تقنية تشوش القرار" : "A plain-language explanation of what was checked"}</h3></header><div><article><strong>{ar ? "السوق" : "Market"}</strong><p>{ar ? `صُنّف النشاط ضمن ${display(profile?.category, "فئة غير محسومة")} ويخدم ${display(profile?.region, "منطقة غير محسومة")}.` : `We identified this as a ${display(profile?.category, "category-unresolved")} business serving ${display(profile?.region, "an unresolved region")}.`}</p></article><article><strong>{ar ? "مطابقة المنتجات" : "Product matching"}</strong><p>{ar ? "احتُفظ بأزواج المنتجات فقط عندما اجتازت بوابة الجودة وظل رابطا المصدر متاحين للتحقق." : `Product pairs were matched using ${display(object(comparison?.matching).method, "a structured similarity check")} and kept only when they cleared the quality gate and retained both source pages.`}</p></article><article><strong>{ar ? "مراجعة الإعلانات" : "Ad checks"}</strong><p>{ar ? `تغطي المراجعة مكتبات الإعلانات العامة الرسمية فقط. ${display(adBlock?.limitation, "التغطية غير مكتملة.")}` : `Ad checks cover only official public ad libraries. ${display(adBlock?.limitation, "Coverage is incomplete.")}`}</p></article></div><p>{ar ? "أي شيء لم يُرصد هنا هو حد للتغطية، وليس دليلاً على الغياب." : "Anything not observed here is a coverage limit, never evidence of absence."}</p><details><summary>{ar ? "السجل التقني" : "Technical record"}</summary><small>{[display(profile?.model || profile?.provider), display(object(comparison?.matching).model), display(adBlock?.model || adBlock?.provider)].filter(Boolean).join(" · ") || (ar ? "لا توجد معرّفات تقنية محفوظة." : "No technical identifiers were saved.")}</small></details></section>
      </>}
      </section>
    </div>
  </div>;
}

export default function StoredReportPage({ params }: { params: Promise<{ publicId: string }> | { publicId: string } }) {
  const [payload, setPayload] = useState<StoredPayload | null>(null); const [error, setError] = useState(""); const [localeOverride, setLocaleOverride] = useState<"en" | "ar" | null>(null);
  useEffect(() => { let current = true; Promise.resolve(params).then(({ publicId }) => fetch(`/api/reports/${publicId}`, { cache: "no-store" })).then(async (response) => ({ response, body: await readJsonResponse<StoredPayload>(response, "Saved report") })).then(({ response, body }) => { if (!current) return; if (!response.ok || !body.ok) setError(body.error || "The saved report could not be opened."); else { setPayload(body); if (!body.report?.document && ["queued", "running"].includes(body.report?.run.status || "")) Promise.resolve(params).then(({ publicId }) => window.location.replace(`/reports/${publicId}/loading`)); } }).catch((cause) => current && setError(jsonResponseErrorMessage(cause, "Saved report"))); return () => { current = false; }; }, [params]);
  const report = payload?.report; const stored = report?.document; const document = stored?.document; const ar = localeOverride ? localeOverride === "ar" : report?.run.locale === "ar"; const dir = ar ? "rtl" : "ltr";
  if (error) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "التقرير غير متاح" : "Report unavailable"}</h1><p>{error}</p></main>;
  if (report && !document && ["failed", "interrupted"].includes(report.run.status)) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "توقف هذا التقرير" : "This report stopped"}</h1><p>{report.run.errorMessage || (ar ? "ابدأ تقريراً جديداً للمحاولة مرة أخرى." : "Start a fresh report to try again.")}</p></main>;
  if (!report || !document) return <main className="stored-report-state"><div className="route-spinner" /><p>Opening the saved market report…</p></main>;
  if (report.documentSchemaVersion !== 1) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "نسخة التقرير غير مدعومة" : "Unsupported report version"}</h1></main>;
  return <main className="stored-report-page" lang={ar ? "ar" : "en"} dir={dir}><ReportWorkspace blocks={document.blocks} primaryProducts={report.primaryProducts} publicId={report.run.publicId} primaryDomain={report.run.primaryDomain} observedAt={report.run.updatedAt} reportStatus={report.run.status} reportEvents={report.events || []} ar={ar} onToggleLocale={() => setLocaleOverride(ar ? "en" : "ar")} /></main>;
}
