"use client";

import Link from "next/link";
import { KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProductDesignLab } from "../../components/product-design-lab";
import { ExperienceBenchmark } from "../../components/experience-benchmark";
import { reportCoverage, type ReportCoverageEvent } from "../../lib/report-coverage";
import { jsonResponseErrorMessage, readJsonResponse } from "../../lib/json-response";
import { countLegacyUngatedProductMatches, publishedComparisonCompetitors } from "../../lib/report-price-publication";
import { stoppedReportPresentation } from "../../lib/stopped-report-presentation";

type Block = { type: string; id: string } & Record<string, unknown>;
type ReportEvent = ReportCoverageEvent;
type View = "overview" | "competitors" | "products" | "evidence";
type StoredPayload = { ok: boolean; error?: string; report?: { run: { publicId: string; primaryDomain: string; locale: "en" | "ar"; status: string; createdAt: string; updatedAt: string; errorCode: string; errorMessage: string; productPlan: string; productLimit: number }; events: ReportEvent[]; document: { document?: { version: "1"; generatedAt: string; blocks: Block[] }; marketBrief?: Record<string, unknown> } | null; documentSchemaVersion: number; primaryProducts?: { authoritative: boolean; totalCount: number; products: Array<Record<string, unknown>>; truncated: boolean } } };
type AccountReport = { publicId: string; primaryDomain: string; status: string; createdAt: string; updatedAt: string };
type AccountReportsPayload = { eligible?: boolean; reports?: AccountReport[] };

const VIEWS: View[] = ["competitors", "products", "overview"];
const VIEW_LABELS: Record<View, { en: string; ar: string }> = {
  overview: { en: "Benchmark", ar: "المقارنة" }, competitors: { en: "Competitors", ar: "المنافسون" },
  products: { en: "Products", ar: "المنتجات" },
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
function scrollToReportHash() {
  const raw = window.location.hash.slice(1); if (!raw) return;
  let id = raw; try { id = decodeURIComponent(raw); } catch { /* Keep a malformed but harmless literal fragment. */ }
  const target = document.getElementById(id);
  const group = target?.closest("details");
  if (group instanceof HTMLDetailsElement) group.open = true;
  target?.scrollIntoView({ block: "start" });
}

function reportHistoryStatus(status: string, ar: boolean) {
  if (status === "complete") return ar ? "جاهز" : "Ready";
  if (status === "limited") return ar ? "محدود" : "Limited";
  if (status === "failed" || status === "interrupted") return ar ? "متوقف" : "Stopped";
  return ar ? "قيد التشغيل" : "Running";
}

function PaidReportHistory({ currentPublicId, ar }: { currentPublicId: string; ar: boolean }) {
  const [history, setHistory] = useState<AccountReportsPayload | null>(null);
  useEffect(() => {
    let current = true;
    fetch("/api/account/reports", { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? readJsonResponse<AccountReportsPayload>(response, "Your reports") : null)
      .then((payload) => { if (current && payload?.eligible) setHistory(payload); })
      .catch(() => { /* Public and unpaid viewers simply keep the private history hidden. */ });
    return () => { current = false; };
  }, []);
  if (!history?.eligible) return null;
  const reports = Array.isArray(history.reports) ? history.reports : [];
  return <section className="dashboard-report-history" aria-label={ar ? "تقاريرك الأخيرة" : "Your recent reports"}>
    <header><span>{ar ? "تقاريرك" : "YOUR REPORTS"}</span><b>{reports.length}</b></header>
    {reports.length ? <ol>{reports.map((report) => {
      const current = report.publicId === currentPublicId;
      const timestamp = Date.parse(report.updatedAt || report.createdAt);
      return <li key={report.publicId}><Link href={`/reports/${report.publicId}?view=products`} aria-current={current ? "page" : undefined} className={current ? "current" : undefined}><i className={`report-history-status status-${report.status}`} aria-hidden="true" /><span><strong dir="auto">{report.primaryDomain}</strong><small>{reportHistoryStatus(report.status, ar)}{Number.isFinite(timestamp) ? ` · ${new Date(timestamp).toLocaleDateString(ar ? "ar" : "en", { month: "short", day: "numeric" })}` : ""}</small></span>{current && <em>{ar ? "الحالي" : "Current"}</em>}</Link></li>;
    })}</ol> : <p>{ar ? "ستظهر تقاريرك هنا بعد أول تشغيل." : "Your reports will appear here after the first run."}</p>}
  </section>;
}

function StoppedReportWorkspace({ run, ar, onToggleLocale }: { run: NonNullable<StoredPayload["report"]>["run"]; ar: boolean; onToggleLocale: () => void }) {
  const presentation = stoppedReportPresentation(run.errorMessage, run.errorCode, ar);
  const observedAt = run.updatedAt || run.createdAt;
  const websiteUrl = safeUrl(`https://${run.primaryDomain}`);
  useEffect(() => {
    const url = new URL(window.location.href);
    const before = url.toString();
    url.searchParams.delete("view"); url.searchParams.delete("layout"); url.hash = "";
    if (url.toString() !== before) window.history.replaceState({}, "", url);
  }, []);
  return <div className="intelligence-workspace report-dashboard-shell stopped-report-shell">
    <aside className="report-dashboard-sidebar">
      <Link className="dashboard-brand" href="/">Market Signal</Link>
      <section className="dashboard-report-identity stopped" aria-label={ar ? "حالة التقرير" : "Report status"}>
        <div><span>{ar ? "نطاق التقرير" : "REPORT SCOPE"}</span><b>{ar ? "متوقف" : "Stopped"}</b></div>
        <strong dir="auto"><i aria-hidden="true" />{run.primaryDomain}</strong>
        <p>{ar ? "لم تُنشأ مقارنة" : "No comparison was created"}</p>
        <small>{ar ? "توقف هذا التشغيل قبل اكتمال الفحوص العامة." : "This run stopped before its public checks completed."}</small>
        <time dateTime={observedAt}>{ar ? "حُدث" : "Updated"} {new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</time>
      </section>
      <PaidReportHistory currentPublicId={run.publicId} ar={ar} />
    </aside>
    <div className="report-dashboard-main">
      <header className="report-route-header">
        <div className="dashboard-view-title"><span>{ar ? "حالة التقرير" : "REPORT STATUS"}</span><b dir="auto">{run.primaryDomain}</b></div>
        <div className="report-route-meta stopped"><span>{ar ? "متوقف" : "Stopped"}</span><time>{ar ? "لوحظ" : "Observed"} {new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</time></div>
        <div className="report-route-actions"><button type="button" onClick={onToggleLocale} aria-label={ar ? "Switch to English" : "التبديل إلى العربية"}>{ar ? "EN" : "ع"}</button><Link href="/">{ar ? "تقرير جديد" : "New report"}</Link></div>
      </header>
      <section className="workspace-panel stopped-report-panel" aria-labelledby="stopped-report-title">
        <section className="stopped-report-card">
          <span>{ar ? "تقرير متوقف" : "STOPPED REPORT"}</span>
          <h1 id="stopped-report-title">{presentation.title}</h1>
          <p>{presentation.summary}</p>
          <div className="stopped-report-actions"><Link href="/">{ar ? "ابدأ تقريراً جديداً" : "Start a new report"}</Link>{websiteUrl && <a href={websiteUrl} target="_blank" rel="noreferrer">{ar ? "افتح الموقع ↗" : "Open website ↗"}</a>}</div>
          {run.errorMessage && <details><summary>{ar ? "التفاصيل التقنية" : "Technical detail"}</summary><p>{run.errorMessage}</p></details>}
        </section>
        <p className="stopped-report-navigation-hint">{ar ? "يمكنك فتح تقرير محفوظ آخر من قائمة تقاريرك." : "Choose another saved report from Your reports, or start a new one."}</p>
      </section>
    </div>
  </div>;
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

  const comparison = blocks.find((block) => block.type === "product-comparison");
  const competitors = useMemo(() => publishedComparisonCompetitors(blocks, comparison).sort((a, b) => numeric(b.comparisonCount) - numeric(a.comparisonCount) || numeric(b.verificationScore) - numeric(a.verificationScore)), [blocks, comparison]);
  const legacyUngatedMatchCount = useMemo(() => countLegacyUngatedProductMatches(comparison), [comparison]);
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
  const evidence = blocks.filter((block) => block.type === "evidence");
  const gaps = blocks.filter((block) => block.type === "gap");
  const domainAlternatives = list(domainStatus?.alternatives).map(object);
  const coverage = blocks.filter((block) => block.type === "coverage");
  const profile = blocks.find((block) => block.type === "market-profile");
  const experienceBenchmark = blocks.find((block) => block.type === "experience-benchmark");
  const coverageStatus = reportCoverage(reportStatus, reportEvents, ar);
  const productAnchor = (domain: unknown) => `rival-${slug(domain)}`;
  const competitorAnchor = (domain: unknown) => `competitor-${slug(domain)}`;
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
      <PaidReportHistory currentPublicId={publicId} ar={ar} />
      <nav className="workspace-tabs" role="tablist" aria-orientation={compactNav ? "horizontal" : "vertical"} aria-label={ar ? "أقسام التقرير" : "Report sections"}>
        {activeViews.map((item, index) => <button key={item} ref={(node) => { tabs.current[index] = node; }} id={`tab-${item}`} type="button" role="tab" aria-selected={view === item} aria-controls={`panel-${item}`} tabIndex={view === item ? 0 : -1} onClick={() => selectView(item)} onKeyDown={(event) => onTabKey(event, index)}>{VIEW_LABELS[item][ar ? "ar" : "en"]}{item === "competitors" && <b>{competitors.length}</b>}{item === "products" && <b>{productMatchTotal}</b>}</button>)}
      </nav>
    </aside>
    <div className="report-dashboard-main">
      <header className="report-route-header"><div className="dashboard-view-title"><span>{ar ? "معلومات السوق" : "MARKET INTELLIGENCE"}</span><b>{VIEW_LABELS[view][ar ? "ar" : "en"]}</b></div><div className={`report-route-meta ${reportStatus === "limited" ? "partial" : "ready"}`} title={coverageStatus.detail}><span>{coverageStatus.label}</span><time>{ar ? "لوحظ" : "Observed"} {new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</time></div><div className="report-route-actions"><button type="button" onClick={onToggleLocale} aria-label={ar ? "Switch to English" : "التبديل إلى العربية"}>{ar ? "EN" : "ع"}</button><Link href="/">{ar ? "تقرير جديد" : "New report"}</Link></div></header>
      <section className="workspace-panel" id={`panel-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`} tabIndex={0}>
      {reportStatus === "limited" && <aside className="report-coverage-notice" role="status"><div><span>{coverageStatus.label}</span><strong>{coverageStatus.title}</strong></div><p>{coverageStatus.detail}</p></aside>}
      {view === "overview" && <>
        {terminalDomain && <header className="panel-intro"><div><span>{ar ? "حالة النطاق" : "DOMAIN STATUS"}</span><h2>{parked ? (ar ? "هذا النطاق معروض للبيع" : "This domain is parked, not an active company site") : (ar ? "تعذر الوصول إلى موقع عام على هذا النطاق" : "No public website response was available for this domain")}</h2><p>{display(domainStatus?.explanation, parked ? (ar ? "يتجه النطاق إلى خدمة عامة لبيع النطاقات، لذلك لم تُشغّل مراحل المنافسين والمنتجات." : "The submitted domain redirects to a public domain-for-sale service. Competitor and product analysis did not run.") : (ar ? "لم يعد العنوان العام باستجابة شبكة بعد محاولتين محدودتين، لذلك لم يبدأ تحليل السوق." : "The public HTTPS address returned no network response after two bounded attempts, so market analysis did not start."))}</p></div><time>{ar ? "لوحظ" : "Observed"}<b>{new Date(observedAt).toLocaleString(ar ? "ar" : "en")}</b></time></header>}
        {terminalDomain && <div className="parked-domain-state"><div><span className="truth-pill limited">{ar ? "تقرير محدود" : "LIMITED REPORT"}</span><strong>{ar ? "لم نفحص المنافسين أو المنتجات" : "Competitors and products were not checked"}</strong><p>{ar ? "هذه ليست نتيجة صفرية. تم تخطي تلك المراحل لأن نطاق الشركة لم يكن متاحاً للتحليل." : parked ? "This is not a zero-result report. Those phases were intentionally skipped because there is no attributable company storefront at the submitted domain." : "This is not a zero-result report. Those phases were intentionally skipped because the submitted address did not return a public website response."}</p><div className="entity-links">{parked && safeUrl(domainStatus?.evidenceUrl) && <a href={safeUrl(domainStatus?.evidenceUrl)} target="_blank" rel="noreferrer">{ar ? "افتح دليل النطاق ↗" : "Open parking evidence ↗"}</a>}{unavailableDomain && safeUrl(domainStatus?.attemptedUrl) && <a href={safeUrl(domainStatus?.attemptedUrl)} target="_blank" rel="noreferrer">{ar ? "افتح العنوان الذي تمت محاولته ↗" : "Open attempted address ↗"}</a>}<Link href="/">{ar ? "تحقق من النطاق أو حاول مرة أخرى" : "Check the domain or try again"}</Link></div></div>{parked && domainAlternatives.length > 0 && <section><span>{ar ? "نطاقات محتملة — الهوية غير متحققة" : "POSSIBLE DOMAINS — IDENTITY NOT VERIFIED"}</span><p>{ar ? "استخدم أحدها فقط إذا أكدت أنه يخص شركتك." : "Use one only if you confirm it belongs to your company."}</p>{domainAlternatives.map((alternative) => <a href={safeUrl(alternative.sourceUrl)} target="_blank" rel="noreferrer" key={display(alternative.domain)}><strong>{display(alternative.domain)}</strong><small>{display(alternative.reason, "Unverified name-related search result")}</small></a>)}</section>}</div>}
        {!terminalDomain && <ExperienceBenchmark block={experienceBenchmark} primaryDomain={primaryDomain} ar={ar} />}
      </>}

      {view === "competitors" && <>
        <header className="panel-intro compact"><div><span>{ar ? "خريطة المنافسين" : "RIVAL MAP"}</span><h2>{ar ? "من ظهر في مقارنات المنتجات المقبولة؟" : "Who appears in the accepted product comparisons?"}</h2><p>{ar ? "تُشتق هذه القائمة من بائعي مقارنات الأسعار المقبولة فقط؛ ولا يُحتسب الاكتشاف العام كمنافس." : "This list is derived only from sellers in accepted priced comparisons; broad discovery does not count as a competitor."}</p></div></header>
        <div className="panel-metrics"><div><strong>{competitors.length}</strong><span>{ar ? "منافسون متحققون" : "verified competitors"}</span></div><div><strong>{competitors.filter((item) => item.hasProductOverlap).length}</strong><span>{ar ? "بتداخل منتجات" : "with product overlap"}</span></div><div><strong>{competitors.filter((item) => display(item.confidence).toLowerCase() === "high").length}</strong><span>{ar ? "ثقة عالية" : "high confidence"}</span></div></div>
        <div className="competitor-workspace-list">{competitors.map((competitor, index) => { const domain = display(competitor.domain); const rivalBattles = battles.filter((battle) => display(battle.match.domain || battle.rival.domain) === domain); const rivalBattleCount = currentMatchSummary?.domainCounts?.[domain] ?? (numeric(competitor.comparisonCount) || rivalBattles.length); const score = numeric(competitor.verificationScore); return <article id={competitorAnchor(domain)} key={display(competitor.id, domain)}><header><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{display(competitor.companyName || domain, domain)}</h3><p>{domain}</p></div><b>{score > 0 ? `${score}/100` : (ar ? "مقارنة" : "PAIR")}</b></header><p className="rival-reason">{display(competitor.reason || competitor.description, ar ? "أُدرج هذا البائع لأن له مقارنة أسعار مقبولة واحدة على الأقل." : "This seller is included because it has at least one accepted priced comparison.")}</p><div className="rival-facts"><span>{display(competitor.relationship, ar ? "مقارنة منتج مسعّرة" : "priced product comparison")}</span><span>{display(competitor.confidence, ar ? "زوج متحقق" : "Verified pair")}</span><span>{rivalBattleCount} {ar ? "مقارنة مقبولة" : "accepted comparisons"}</span></div><div className="entity-links"><a href={viewHref("products", productAnchor(domain))}>{ar ? `${rivalBattleCount} مقارنة منتجات` : `${rivalBattleCount} product battles`}</a>{safeUrl(competitor.websiteSourceUrl || competitor.discoverySourceUrl) && <a href={safeUrl(competitor.websiteSourceUrl || competitor.discoverySourceUrl)} target="_blank" rel="noreferrer">{ar ? "موقع المنافس ↗" : "Competitor site ↗"}</a>}</div></article>; })}</div>
        {!competitors.length && <div className="truth-state limited"><strong>{ar ? "لم يتم التحقق من منافس" : "No competitor was verified"}</strong><p>{ar ? "هذا نقص في التغطية، وليس دليلاً على عدم وجود منافسين." : "This is a coverage gap, not proof that no competitors exist."}</p></div>}
      </>}

      {view === "products" && <>
        {legacyUngatedMatchCount > 0 && <aside className="report-coverage-notice" role="status"><div><span>{ar ? "تقرير قديم" : "LEGACY REPORT"}</span><strong>{ar ? "تحتاج مقارنات الأسعار المحفوظة إلى إعادة التحقق" : "Saved price comparisons need revalidation"}</strong></div><p>{ar ? "أُنشئ هذا التقرير قبل بوابة التحقق الحالية للسوق والعملة. أخفينا صفوفه القديمة بدلاً من عرض أسعار قد تكون من سوق مختلف. شغّل تقريراً جديداً للحصول على مقارنات متحققة." : "This report predates the current market-and-currency validation gate. Its older rows are hidden rather than showing prices that may belong to another market. Run a new report for verified comparisons."}</p><Link href="/">{ar ? "شغّل تقريراً جديداً" : "Run a new report"}</Link></aside>}
        <ProductDesignLab key={publicId} comparison={comparison} battles={battles} primaryProducts={primaryProducts} publicId={publicId} authoritativeMatchTotal={productMatchTotal || undefined} onAuthoritativeSummary={receiveAuthoritativeMatchSummary} primaryDomain={primaryDomain} observedAt={observedAt} ar={ar} />
      </>}

      {view === "evidence" && <>
        <header className="panel-intro compact"><div><span>{ar ? "الأدلة والحدود" : "SOURCES & LIMITS"}</span><h2>{ar ? "ما الذي يدعم قرارات هذا التقرير، وما الذي لا يثبته؟" : "What supports this report's decisions—and what does it not prove?"}</h2><p>{ar ? "تظل الحقائق والاستنتاجات وفجوات التغطية منفصلة. افتح مجموعة فقط عندما تريد التحقق من مصدر." : "Facts, interpretations, and coverage gaps stay separate. Open a group only when you need to verify a source."}</p></div></header>
        <div className="truth-legend"><div className="observed"><span>{ar ? "مرصود" : "OBSERVED"}</span><p>{ar ? "ظهر مباشرة في مصدر عام." : "Directly present in a public source."}</p></div><div className="inferred"><span>{ar ? "مستنتج" : "INFERRED"}</span><p>{ar ? "تفسير مبني على أدلة مرتبطة." : "An interpretation based on linked evidence."}</p></div><div className="limited"><span>{ar ? "محدود" : "LIMITED"}</span><p>{ar ? "تم الفحص لكن التغطية غير مكتملة." : "A check ran, but coverage is incomplete."}</p></div><div className="unavailable"><span>{ar ? "غير متاح" : "UNAVAILABLE"}</span><p>{ar ? "تعذر الوصول إلى المصدر أو الموفر." : "The source or provider could not be accessed."}</p></div></div>
        <div className="panel-metrics evidence-metrics"><div><strong>{evidence.length}</strong><span>{ar ? "ادعاءات مرتبطة بالمصدر" : "source-linked claims"}</span></div><div><strong>{evidence.filter((item) => display(item.claimType).toLowerCase() === "observed").length}</strong><span>{ar ? "مرصودة" : "observed"}</span></div><div><strong>{evidence.filter((item) => display(item.claimType).toLowerCase() === "inferred").length}</strong><span>{ar ? "مستنتجة" : "inferred"}</span></div><div><strong>{gaps.length}</strong><span>{ar ? "فجوات معلنة" : "open gaps"}</span></div></div>
        <div className="evidence-groups">{[primaryDomain, ...competitors.map((item) => display(item.domain))].filter((domain, index, all) => domain && all.indexOf(domain) === index).map((domain) => { const claims = evidence.filter((claim) => { try { return new URL(safeUrl(claim.sourceUrl)).hostname.replace(/^www\./, "") === domain.replace(/^www\./, ""); } catch { return false; } }); return <details className="evidence-source-group" id={evidenceAnchor(domain)} key={domain}><summary><div><span>{domain === primaryDomain ? (ar ? "شركتك" : "YOUR COMPANY") : (ar ? "منافس" : "COMPETITOR")}</span><h3>{domain}</h3></div><b>{claims.length} {ar ? "مصدر" : "claims"}</b></summary>{claims.length ? <div>{claims.map((claim) => <article key={claim.id}><span className={`truth-pill ${display(claim.claimType, "observed").toLowerCase()}`}>{display(claim.claimType, ar ? "مرصود" : "Observed")}</span><p dir="auto">{display(claim.text)}</p><footer><b>{display(claim.confidence, ar ? "ثقة محدودة" : "Limited confidence")}</b><a href={safeUrl(claim.sourceUrl)} target="_blank" rel="noreferrer">{ar ? "افتح المصدر ↗" : "Open source ↗"}</a></footer></article>)}</div> : <p className="group-empty">{ar ? "لا توجد ادعاءات محفوظة لهذا النطاق." : "No saved claims for this domain."}</p>}</details>; })}</div>
        <div className="coverage-list"><h3>{ar ? "تغطية الزحف" : "Crawl coverage"}</h3>{coverage.map((item) => <article key={item.id}><strong>{display(item.domain)}</strong><span>{numeric(item.pagesFetched)}/{numeric(item.pagesRequested)} {ar ? "صفحات" : "pages"}</span><p>{list(item.gaps).map((gap) => display(gap)).filter(Boolean).join(" · ") || (ar ? "لم تُحفظ فجوة لهذا النطاق." : "No crawl gap was saved for this domain.")}</p></article>)}</div>
        <div className="coverage-list gaps"><h3>{ar ? "فجوات التحقيق" : "Investigation gaps"}</h3>{gaps.slice(0, 30).map((gap) => <article key={gap.id}><strong>{display(gap.domain, ar ? "مصدر عام" : "Public source")}</strong><span>{display(gap.observedAt) && new Date(display(gap.observedAt)).toLocaleDateString(ar ? "ar" : "en")}</span><p>{display(gap.reason)}</p>{safeUrl(gap.url) && <a href={safeUrl(gap.url)} target="_blank" rel="noreferrer">{ar ? "افتح المصدر ↗" : "Open source ↗"}</a>}</article>)}</div>
        <section className="plain-method" id="method"><header><span>{ar ? "كيف أُعد هذا التقرير" : "HOW THIS REPORT WAS ASSEMBLED"}</span><h3>{ar ? "طريقة واضحة، من دون تفاصيل تقنية تشوش القرار" : "A plain-language explanation of what was checked"}</h3></header><div><article><strong>{ar ? "السوق" : "Market"}</strong><p>{ar ? `صُنّف النشاط ضمن ${display(profile?.category, "فئة غير محسومة")} ويخدم ${display(profile?.region, "منطقة غير محسومة")}.` : `We identified this as a ${display(profile?.category, "category-unresolved")} business serving ${display(profile?.region, "an unresolved region")}.`}</p></article><article><strong>{ar ? "مطابقة المنتجات" : "Product matching"}</strong><p>{ar ? "احتُفظ بأزواج المنتجات فقط عندما اجتازت بوابة الجودة وظل رابطا المصدر متاحين للتحقق." : `Product pairs were matched using ${display(object(comparison?.matching).method, "a structured similarity check")} and kept only when they cleared the quality gate and retained both source pages.`}</p></article></div><p>{ar ? "أي شيء لم يُرصد هنا هو حد للتغطية، وليس دليلاً على الغياب." : "Anything not observed here is a coverage limit, never evidence of absence."}</p><details><summary>{ar ? "السجل التقني" : "Technical record"}</summary><small>{[display(profile?.model || profile?.provider), display(object(comparison?.matching).model)].filter(Boolean).join(" · ") || (ar ? "لا توجد معرّفات تقنية محفوظة." : "No technical identifiers were saved.")}</small></details></section>
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
  if (report && !document && ["failed", "interrupted"].includes(report.run.status)) return <main className="stored-report-page" lang={ar ? "ar" : "en"} dir={dir}><StoppedReportWorkspace run={report.run} ar={ar} onToggleLocale={() => setLocaleOverride(ar ? "en" : "ar")} /></main>;
  if (!report || !document) return <main className="stored-report-state"><div className="route-spinner" /><p>Opening the saved market report…</p></main>;
  if (report.documentSchemaVersion !== 1) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "نسخة التقرير غير مدعومة" : "Unsupported report version"}</h1></main>;
  return <main className="stored-report-page" lang={ar ? "ar" : "en"} dir={dir}><ReportWorkspace blocks={document.blocks} primaryProducts={report.primaryProducts} publicId={report.run.publicId} primaryDomain={report.run.primaryDomain} observedAt={report.run.updatedAt} reportStatus={report.run.status} reportEvents={report.events || []} ar={ar} onToggleLocale={() => setLocaleOverride(ar ? "en" : "ar")} /></main>;
}
