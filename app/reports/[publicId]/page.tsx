"use client";

import Link from "next/link";
import { KeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { PricePosition } from "../../components/price-position";

type Block = { type: string; id: string } & Record<string, unknown>;
type View = "overview" | "competitors" | "products" | "ads" | "evidence" | "methodology";
type StoredPayload = { ok: boolean; error?: string; report?: { run: { primaryDomain: string; locale: "en" | "ar"; status: string; createdAt: string; updatedAt: string; errorMessage: string }; document: { document?: { version: "1"; generatedAt: string; blocks: Block[] }; marketBrief?: Record<string, unknown> } | null; documentSchemaVersion: number } };

const VIEWS: View[] = ["overview", "competitors", "products", "ads", "evidence", "methodology"];
const VIEW_LABELS: Record<View, { en: string; ar: string }> = {
  overview: { en: "Overview", ar: "نظرة عامة" }, competitors: { en: "Competitors", ar: "المنافسون" },
  products: { en: "Products", ar: "المنتجات" }, ads: { en: "Ads", ar: "الإعلانات" },
  evidence: { en: "Evidence", ar: "الأدلة" }, methodology: { en: "Methodology", ar: "المنهجية" },
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
function viewFromLocation(): View { const value = new URLSearchParams(window.location.search).get("view"); return VIEWS.includes(value as View) ? value as View : "overview"; }
function viewHref(view: View, anchor = "") { return `?view=${view}${anchor ? `#${anchor}` : ""}`; }
function productPrice(product: Record<string, unknown>) { return list(product.priceSignals).map((item) => display(object(item).raw)).filter(Boolean)[0] || ""; }
function statusTone(status: string) { return status === "verified-active" ? "observed" : status === "access-limited" ? "limited" : status === "no-verified-result" ? "unavailable" : "inferred"; }
function scrollToReportHash() {
  const raw = window.location.hash.slice(1); if (!raw) return;
  let id = raw; try { id = decodeURIComponent(raw); } catch { /* Keep a malformed but harmless literal fragment. */ }
  document.getElementById(id)?.scrollIntoView({ block: "start" });
}

function ReportWorkspace({ blocks, marketBrief, primaryDomain, observedAt, reportStatus, ar, onToggleLocale }: { blocks: Block[]; marketBrief: Record<string, unknown>; primaryDomain: string; observedAt: string; reportStatus: string; ar: boolean; onToggleLocale: () => void }) {
  const [view, setView] = useState<View>("overview");
  const [compactNav, setCompactNav] = useState(false);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => { const sync = () => setView(viewFromLocation()); sync(); window.addEventListener("popstate", sync); return () => window.removeEventListener("popstate", sync); }, []);
  useEffect(() => { const media = window.matchMedia("(max-width: 1023px)"); const sync = () => setCompactNav(media.matches); sync(); media.addEventListener("change", sync); return () => media.removeEventListener("change", sync); }, []);
  useEffect(() => { const frame = window.requestAnimationFrame(scrollToReportHash); window.addEventListener("hashchange", scrollToReportHash); return () => { window.cancelAnimationFrame(frame); window.removeEventListener("hashchange", scrollToReportHash); }; }, [view, blocks]);
  useEffect(() => { if (compactNav) tabs.current[VIEWS.indexOf(view)]?.scrollIntoView({ inline: "nearest", block: "nearest" }); }, [compactNav, view]);
  const selectView = (next: View, replace = false, hash = "") => { const url = new URL(window.location.href); url.searchParams.set("view", next); url.hash = hash; window.history[replace ? "replaceState" : "pushState"]({}, "", url); setView(next); };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forwardKey = compactNav ? (ar ? "ArrowLeft" : "ArrowRight") : "ArrowDown"; const backwardKey = compactNav ? (ar ? "ArrowRight" : "ArrowLeft") : "ArrowUp";
    const next = event.key === forwardKey ? (index + 1) % VIEWS.length : event.key === backwardKey ? (index - 1 + VIEWS.length) % VIEWS.length : event.key === "Home" ? 0 : event.key === "End" ? VIEWS.length - 1 : -1;
    if (next < 0) return; event.preventDefault(); tabs.current[next]?.focus(); selectView(VIEWS[next]);
  };
  const onWorkspaceClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href^="?view="]'); if (!anchor) return;
    const url = new URL(anchor.href); const next = url.searchParams.get("view") as View; if (!VIEWS.includes(next)) return;
    event.preventDefault(); selectView(next, false, url.hash);
  };

  const competitors = useMemo(() => blocks.filter((block) => block.type === "competitor").sort((a, b) => numeric(b.verificationScore) - numeric(a.verificationScore)), [blocks]);
  const comparison = blocks.find((block) => block.type === "product-comparison");
  const battles = useMemo(() => list(comparison?.rows).flatMap((row, rowIndex) => {
    const item = object(row); const primary = object(item.primary);
    return list(item.matches).flatMap((match, matchIndex) => { const candidate = object(match); const rival = object(candidate.product); return rival.name ? [{ primary, rival, match: candidate, key: `${rowIndex}-${matchIndex}` }] : []; });
  }), [comparison]);
  const adBlock = blocks.find((block) => block.type === "ad-intelligence");
  const adCompanies = list(adBlock?.companies).map(object);
  const evidence = blocks.filter((block) => block.type === "evidence");
  const gaps = blocks.filter((block) => block.type === "gap");
  const coverage = blocks.filter((block) => block.type === "coverage");
  const profile = blocks.find((block) => block.type === "market-profile");
  const strongest = competitors[0];
  const activeAds = adCompanies.reduce((total, company) => total + list(company.platforms).filter((platform) => display(object(platform).status) === "verified-active").length, 0);
  const signals = list(marketBrief.signals).map(object).slice(0, 3);
  const nextChecks = list(marketBrief.nextChecks).map((item) => display(item)).filter(Boolean).slice(0, 3);
  const firstBattleByDomain = new Map<string, string>();
  for (const battle of battles) {
    const domain = display(battle.match.domain || battle.rival.domain);
    if (domain && !firstBattleByDomain.has(domain)) firstBattleByDomain.set(domain, battle.key);
  }

  const productAnchor = (domain: unknown) => `rival-${slug(domain)}`;
  const competitorAnchor = (domain: unknown) => `competitor-${slug(domain)}`;
  const adAnchor = (domain: unknown) => `ad-${slug(domain)}`;
  const evidenceAnchor = (domain: unknown) => `evidence-${slug(domain)}`;

  return <div className="intelligence-workspace report-dashboard-shell" onClick={onWorkspaceClick}>
    <aside className="report-dashboard-sidebar">
      <Link className="dashboard-brand" href="/">Market Signal</Link>
      <div className="dashboard-report-identity"><span>{reportStatus.toUpperCase()}</span><strong dir="auto">{primaryDomain}</strong><small>{ar ? "آخر تحديث" : "Updated"} {new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</small></div>
      <nav className="workspace-tabs" role="tablist" aria-orientation={compactNav ? "horizontal" : "vertical"} aria-label={ar ? "أقسام التقرير" : "Report sections"}>
        {VIEWS.map((item, index) => <button key={item} ref={(node) => { tabs.current[index] = node; }} id={`tab-${item}`} type="button" role="tab" aria-selected={view === item} aria-controls={`panel-${item}`} tabIndex={view === item ? 0 : -1} onClick={() => selectView(item)} onKeyDown={(event) => onTabKey(event, index)}>{VIEW_LABELS[item][ar ? "ar" : "en"]}{item === "competitors" && <b>{competitors.length}</b>}{item === "products" && <b>{battles.length}</b>}{item === "evidence" && <b>{evidence.length}</b>}</button>)}
      </nav>
    </aside>
    <div className="report-dashboard-main">
      <header className="report-route-header"><div className="dashboard-view-title"><span>{ar ? "معلومات السوق" : "MARKET INTELLIGENCE"}</span><b>{VIEW_LABELS[view][ar ? "ar" : "en"]}</b></div><div className="report-route-meta"><span>{reportStatus.toUpperCase()}</span><time>{ar ? "لوحظ" : "Observed"} {new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</time></div><div className="report-route-actions"><button type="button" onClick={onToggleLocale} aria-label={ar ? "Switch to English" : "التبديل إلى العربية"}>{ar ? "EN" : "ع"}</button><Link href="/">{ar ? "تقرير جديد" : "New report"}</Link></div></header>
      <section className="workspace-panel" id={`panel-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`} tabIndex={0}>
      {view === "overview" && <>
        <header className="panel-intro"><div><span>{ar ? "القرار أولاً" : "DECISION FIRST"}</span><h2>{display(marketBrief.headline, ar ? `${primaryDomain} في مواجهة السوق` : `${primaryDomain} against the market`)}</h2><p>{display(marketBrief.summary, ar ? "تستند هذه الخلاصة إلى الأدلة العامة المحفوظة في هذا التقرير." : "This verdict uses only the public evidence saved with this report.")}</p></div><time>{ar ? "لوحظ" : "Observed"}<b>{new Date(observedAt).toLocaleString(ar ? "ar" : "en")}</b></time></header>
        <div className="decision-signals">
          <a href={strongest ? viewHref("competitors", competitorAnchor(strongest.domain)) : viewHref("competitors")}><span>{ar ? "أقوى منافس" : "STRONGEST RIVAL"}</span><strong>{display(strongest?.companyName || strongest?.domain, ar ? "لم يتم التحقق" : "Not verified")}</strong><small>{strongest ? `${numeric(strongest.verificationScore)}/100` : ar ? "تغطية محدودة" : "Limited coverage"}</small></a>
          <a href={viewHref("products")}><span>{ar ? "مقارنات موثقة" : "PRODUCT BATTLES"}</span><strong>{battles.length}</strong><small>{ar ? "أزواج منتجات مرتبطة بالمصدر" : "source-linked pairs"}</small></a>
          <a href={viewHref("ads")}><span>{ar ? "نشاط إعلاني متحقق" : "VERIFIED AD SIGNALS"}</span><strong>{activeAds}</strong><small>{activeAds ? (ar ? "نتائج مكتبة نشطة" : "active library results") : (ar ? "ليست دليلاً على عدم وجود إعلانات" : "not proof of zero ads")}</small></a>
        </div>
        {signals.length > 0 && <div className="insight-grid">{signals.map((signal, index) => <article key={`${display(signal.label)}-${index}`}><span>{ar ? "إشارة" : "SIGNAL"} {String(index + 1).padStart(2, "0")}</span><h3>{display(signal.label, ar ? "إشارة السوق" : "Market signal")}</h3><p>{display(signal.text)}</p><strong>{display(signal.implication)}</strong></article>)}</div>}
        {nextChecks.length > 0 && <div className="next-actions"><span>{ar ? "الخطوات التالية" : "NEXT ACTIONS"}</span>{nextChecks.map((check, index) => <p key={`${check}-${index}`}><b>{index + 1}</b>{check}</p>)}</div>}
      </>}

      {view === "competitors" && <>
        <header className="panel-intro compact"><div><span>{ar ? "خريطة المنافسين" : "RIVAL MAP"}</span><h2>{ar ? "من ينافسك على نفس العميل؟" : "Who competes for the same customer?"}</h2><p>{ar ? "تم تضمين الشركات التي اجتازت التحقق من الفئة والسوق. تشابه المنتجات يقوي العلاقة." : "Included companies passed category and market verification. Product overlap strengthens the relationship."}</p></div></header>
        <div className="panel-metrics"><div><strong>{competitors.length}</strong><span>{ar ? "منافسون متحققون" : "verified competitors"}</span></div><div><strong>{competitors.filter((item) => item.hasProductOverlap).length}</strong><span>{ar ? "بتداخل منتجات" : "with product overlap"}</span></div><div><strong>{competitors.filter((item) => display(item.confidence).toLowerCase() === "high").length}</strong><span>{ar ? "ثقة عالية" : "high confidence"}</span></div></div>
        <div className="competitor-workspace-list">{competitors.map((competitor, index) => { const domain = display(competitor.domain); const rivalBattles = battles.filter((battle) => display(battle.match.domain || battle.rival.domain) === domain); const advertiser = adCompanies.find((company) => display(company.domain) === domain); return <article id={competitorAnchor(domain)} key={competitor.id}><header><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{display(competitor.companyName || domain, domain)}</h3><p>{domain}</p></div><b>{numeric(competitor.verificationScore)}/100</b></header><p className="rival-reason">{display(competitor.reason || competitor.description, ar ? "تم التحقق من تداخل السوق من المصادر العامة." : "Public sources verify market overlap.")}</p><div className="rival-facts"><span>{display(competitor.relationship, "direct")}</span><span>{display(competitor.confidence, "Limited")} {ar ? "الثقة" : "confidence"}</span><span>{numeric(competitor.productCount)} {ar ? "منتجاً مرصوداً" : "products observed"}</span></div><div className="entity-links"><a href={viewHref("products", productAnchor(domain))}>{ar ? `${rivalBattles.length} مقارنة منتجات` : `${rivalBattles.length} product battles`}</a><a href={viewHref("ads", adAnchor(domain))}>{advertiser ? (ar ? "تغطية الإعلانات" : "Ad coverage") : (ar ? "لا توجد تغطية محفوظة" : "No saved ad coverage")}</a><a href={viewHref("evidence", evidenceAnchor(domain))}>{ar ? "الأدلة" : "Evidence"}</a>{safeUrl(competitor.websiteSourceUrl || competitor.discoverySourceUrl) && <a href={safeUrl(competitor.websiteSourceUrl || competitor.discoverySourceUrl)} target="_blank" rel="noreferrer">{ar ? "موقع المنافس ↗" : "Competitor site ↗"}</a>}</div></article>; })}</div>
        {!competitors.length && <div className="truth-state limited"><strong>{ar ? "لم يتم التحقق من منافس" : "No competitor was verified"}</strong><p>{ar ? "هذا نقص في التغطية، وليس دليلاً على عدم وجود منافسين." : "This is a coverage gap, not proof that no competitors exist."}</p></div>}
      </>}

      {view === "products" && <>
        <header className="panel-intro compact"><div><span>{ar ? "مقارنة منتج بمنتج" : "PRODUCT VS PRODUCT"}</span><h2>{ar ? "أقرب بدائل المنافسين لمنتجاتك" : "The closest rival alternatives to your products"}</h2><p>{ar ? "كل زوج يحافظ على رابطَي المنتج، وقرار المطابقة، والثقة، والأسعار العامة عندما تكون متاحة." : "Every pair keeps both product sources, the match verdict, confidence, and public prices when available."}</p></div></header>
        <div className="panel-metrics"><div><strong>{battles.length}</strong><span>{ar ? "مطابقات مقبولة" : "accepted matches"}</span></div><div><strong>{battles.filter((battle) => productPrice(battle.primary) && productPrice(battle.rival)).length}</strong><span>{ar ? "بأسعار على الجانبين" : "with two-sided prices"}</span></div><div><strong>{list(comparison?.rows).length}</strong><span>{ar ? "منتجاتك التي تم تقييمها" : "your products assessed"}</span></div></div>
        <div className="product-workspace-list">{battles.map((battle) => { const domain = display(battle.match.domain || battle.rival.domain); const assessment = object(battle.match.assessment); const decision = object(battle.match.decision); const primaryPrice = productPrice(battle.primary); const rivalPrice = productPrice(battle.rival); const anchor = firstBattleByDomain.get(domain) === battle.key ? productAnchor(domain) : `${productAnchor(domain)}-${slug(battle.rival.id || battle.key)}`; return <article id={anchor} key={battle.key} data-rival={domain}><div className="battle-context"><a href={viewHref("competitors", competitorAnchor(domain))}>{display(domain, ar ? "المنافس" : "Competitor")}</a><span className={`truth-pill ${display(assessment.claimType, "inferred").toLowerCase()}`}>{display(assessment.claimType, ar ? "مستنتج" : "Inferred")}</span><b>{display(battle.match.confidence, ar ? "ثقة محدودة" : "Limited confidence")}</b></div><div className="workspace-product-pair"><div>{safeUrl(battle.primary.imageUrl) && <img src={safeUrl(battle.primary.imageUrl)} alt="" />}<span>{ar ? "منتجك" : "YOUR PRODUCT"}</span><h3 dir="auto">{display(battle.primary.name, ar ? "منتج مرصود" : "Observed product")}</h3><strong>{primaryPrice || (ar ? "السعر غير مرصود" : "Price not observed")}</strong></div><i>↔</i><div>{safeUrl(battle.rival.imageUrl) && <img src={safeUrl(battle.rival.imageUrl)} alt="" />}<span>{ar ? "منتج المنافس" : "RIVAL PRODUCT"}</span><h3 dir="auto">{display(battle.rival.name, ar ? "منتج منافس مرصود" : "Observed rival product")}</h3><strong>{rivalPrice || (ar ? "السعر غير مرصود" : "Price not observed")}</strong></div></div><PricePosition comparisonValue={decision.priceComparison} primaryRaw={primaryPrice} rivalRaw={rivalPrice} priceVerdict={display(decision.priceVerdict)} locale={ar ? "ar" : "en"} /><div className="battle-decision"><div><span>{ar ? "حكم المطابقة" : "MATCH VERDICT"}</span><strong>{display(assessment.verdict || battle.match.confidence, ar ? "بديل قريب" : "Close substitute")}</strong><p>{list(assessment.reasons).map((reason) => display(reason)).filter(Boolean).join(" · ") || list(battle.match.sharedTerms).map((term) => display(term)).filter(Boolean).join(" · ")}</p></div><div><span>{ar ? "ماذا تفعل" : "RECOMMENDED MOVE"}</span><strong>{display(decision.recommendedMove, ar ? "راجع المنتجين قبل اتخاذ قرار." : "Review both products before acting.")}</strong><p>{display(decision.priceVerdict)}</p></div></div><footer><a href={safeUrl(battle.primary.sourceUrl)} target="_blank" rel="noreferrer">{ar ? "مصدر منتجك ↗" : "Your product source ↗"}</a><a href={safeUrl(battle.rival.sourceUrl)} target="_blank" rel="noreferrer">{ar ? "مصدر المنافس ↗" : "Rival product source ↗"}</a><a href={viewHref("evidence", evidenceAnchor(domain))}>{ar ? "أدلة المنافس" : "Rival evidence"}</a></footer></article>; })}</div>
        {!battles.length && <div className="truth-state limited"><strong>{ar ? "لا توجد مطابقة منتجات موثقة" : "No defensible product match was saved"}</strong><p>{ar ? "تم فحص الكتالوج، لكن لا ينبغي عرض زوج ضعيف على أنه مقارنة." : "Catalogs were assessed, but a weak pair should not be presented as a comparison."}</p></div>}
      </>}

      {view === "ads" && <>
        <header className="panel-intro compact"><div><span>{ar ? "مراقبة الإعلانات" : "AD MONITORING"}</span><h2>{ar ? "ما الذي أمكن التحقق منه في المكتبات العامة؟" : "What could be verified in public ad libraries?"}</h2><p>{display(adBlock?.limitation, ar ? "تختلف تغطية مكتبات الإعلانات حسب السوق والمنصة." : "Ad-library coverage varies by market and platform.")}</p></div></header>
        <div className="panel-metrics"><div><strong>{adCompanies.length}</strong><span>{ar ? "شركات تم فحصها" : "companies checked"}</span></div><div><strong>{activeAds}</strong><span>{ar ? "إشارات نشاط متحققة" : "verified active signals"}</span></div><div><strong>{adCompanies.reduce((total, company) => total + list(company.platforms).filter((platform) => display(object(platform).status) === "access-limited").length, 0)}</strong><span>{ar ? "فحوص محدودة الوصول" : "access-limited checks"}</span></div></div>
        <div className="ad-workspace-list">{adCompanies.map((company) => { const domain = display(company.domain); const platforms = list(company.platforms).map(object); return <article id={adAnchor(domain)} key={domain}><header><div><span>{ar ? "المعلن" : "ADVERTISER"}</span><h3>{display(company.brand || domain, domain)}</h3><p>{domain}</p></div><a href={viewHref("competitors", competitorAnchor(domain))}>{domain === primaryDomain ? (ar ? "شركتك" : "Your company") : (ar ? "ملف المنافس" : "Rival dossier")}</a></header><p>{display(company.summary)}</p><div className="platform-checks">{platforms.map((platform) => { const status = display(platform.status, "access-limited"); const evidenceUrls = list(platform.evidenceUrls).map(safeUrl).filter(Boolean); return <section className={statusTone(status)} key={display(platform.platform)}><div><span>{display(platform.platform)}</span><b>{status === "verified-active" ? `${numeric(platform.activeCreativeCount)} ${ar ? "إعلان نشط" : "active"}` : status.replace(/-/g, " ")}</b></div><p>{display(platform.message)}</p><div className="entity-links">{evidenceUrls.map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={url}>{ar ? `سجل ${index + 1} ↗` : `Ad record ${index + 1} ↗`}</a>)}{safeUrl(platform.searchUrl) && <a href={safeUrl(platform.searchUrl)} target="_blank" rel="noreferrer">{ar ? "افتح البحث الرسمي ↗" : "Open official search ↗"}</a>}</div></section>; })}</div><div className="ad-action"><span>{ar ? "الإجراء التالي" : "NEXT ACTION"}</span><strong>{display(company.recommendedAction, ar ? "أعد الفحص قبل استخلاص نتيجة." : "Recheck before drawing a conclusion.")}</strong></div></article>; })}</div>
        {!adCompanies.length && <div className="truth-state unavailable"><strong>{ar ? "تغطية الإعلانات غير متاحة" : "Ad coverage is unavailable"}</strong><p>{ar ? "لم يتم حفظ نتيجة مكتبة لهذا التشغيل. هذا لا يعني أن الشركات لا تعلن." : "No library result was saved for this run. This does not mean the companies do not advertise."}</p></div>}
      </>}

      {view === "evidence" && <>
        <header className="panel-intro compact"><div><span>{ar ? "سجل الأدلة" : "EVIDENCE LEDGER"}</span><h2>{ar ? "المصادر العامة خلف التقرير" : "The public sources behind this report"}</h2><p>{ar ? "المرصود والمستنتج يظلان منفصلين. افتح أي رابط للتحقق من المصدر الأولي." : "Observed and inferred claims stay separate. Open any link to verify the first-party source."}</p></div></header>
        <div className="panel-metrics"><div><strong>{evidence.length}</strong><span>{ar ? "ادعاءات مرتبطة بالمصدر" : "source-linked claims"}</span></div><div><strong>{evidence.filter((item) => display(item.claimType).toLowerCase() === "observed").length}</strong><span>{ar ? "مرصودة" : "observed"}</span></div><div><strong>{evidence.filter((item) => display(item.claimType).toLowerCase() === "inferred").length}</strong><span>{ar ? "مستنتجة" : "inferred"}</span></div></div>
        <div className="evidence-groups">{[primaryDomain, ...competitors.map((item) => display(item.domain))].filter((domain, index, all) => domain && all.indexOf(domain) === index).map((domain) => { const claims = evidence.filter((claim) => { try { return new URL(safeUrl(claim.sourceUrl)).hostname.replace(/^www\./, "") === domain.replace(/^www\./, ""); } catch { return false; } }); return <section id={evidenceAnchor(domain)} key={domain}><header><div><span>{domain === primaryDomain ? (ar ? "شركتك" : "YOUR COMPANY") : (ar ? "منافس" : "COMPETITOR")}</span><h3>{domain}</h3></div><b>{claims.length}</b></header>{claims.length ? <div>{claims.map((claim) => <article key={claim.id}><span className={`truth-pill ${display(claim.claimType, "observed").toLowerCase()}`}>{display(claim.claimType, ar ? "مرصود" : "Observed")}</span><p dir="auto">{display(claim.text)}</p><footer><b>{display(claim.confidence, ar ? "ثقة محدودة" : "Limited confidence")}</b><a href={safeUrl(claim.sourceUrl)} target="_blank" rel="noreferrer">{ar ? "افتح المصدر ↗" : "Open source ↗"}</a></footer></article>)}</div> : <p className="group-empty">{ar ? "لا توجد ادعاءات محفوظة لهذا النطاق." : "No saved claims for this domain."}</p>}</section>; })}</div>
      </>}

      {view === "methodology" && <>
        <header className="panel-intro compact"><div><span>{ar ? "حدود الطريقة" : "METHOD & LIMITS"}</span><h2>{ar ? "كيف جُمعت النتائج وما الذي لا تثبته" : "How the result was assembled—and what it does not prove"}</h2><p>{ar ? "يحتفظ التقرير بحالات الفجوات والتغطية حتى لا تتحول البيانات المفقودة إلى استنتاجات خاطئة." : "Coverage and gap states are preserved so missing data never becomes a false conclusion."}</p></div></header>
        <div className="truth-legend"><div className="observed"><span>{ar ? "مرصود" : "OBSERVED"}</span><p>{ar ? "ظهر مباشرة في مصدر عام." : "Directly present in a public source."}</p></div><div className="inferred"><span>{ar ? "مستنتج" : "INFERRED"}</span><p>{ar ? "تفسير مبني على أدلة مرتبطة." : "An interpretation based on linked evidence."}</p></div><div className="limited"><span>{ar ? "محدود" : "LIMITED"}</span><p>{ar ? "تم الفحص لكن التغطية غير مكتملة." : "A check ran, but coverage is incomplete."}</p></div><div className="unavailable"><span>{ar ? "غير متاح" : "UNAVAILABLE"}</span><p>{ar ? "تعذر الوصول إلى المصدر أو الموفر." : "The source or provider could not be accessed."}</p></div></div>
        <div className="method-grid"><article><span>{ar ? "ملف السوق" : "MARKET PROFILE"}</span><h3>{display(profile?.category, ar ? "الفئة غير محسومة" : "Category unresolved")}</h3><p>{display(profile?.region, ar ? "المنطقة غير محسومة" : "Region unresolved")}</p><small>{display(profile?.model || profile?.provider, ar ? "تحليل قائم على الأدلة" : "Evidence-based analysis")}</small></article><article><span>{ar ? "مطابقة المنتجات" : "PRODUCT MATCHING"}</span><h3>{display(object(comparison?.matching).method, ar ? "طريقة غير محفوظة" : "Method not saved")}</h3><p>{ar ? "لا تُقبل المطابقة إلا عندما تتجاوز عتبة الجودة وتحافظ على رابطَي المصدر." : "A match is accepted only when it clears the quality gate and retains both sources."}</p><small>{display(object(comparison?.matching).model)}</small></article><article><span>{ar ? "تغطية الإعلانات" : "AD COVERAGE"}</span><h3>{display(adBlock?.provider, ar ? "غير متاحة" : "Unavailable")}</h3><p>{display(adBlock?.limitation, ar ? "لا يمكن اعتبار غياب النتيجة دليلاً على غياب الإعلان." : "A missing result cannot be treated as proof of no advertising.")}</p><small>{display(adBlock?.model)}</small></article></div>
        <div className="coverage-list"><h3>{ar ? "تغطية الزحف" : "Crawl coverage"}</h3>{coverage.map((item) => <article key={item.id}><strong>{display(item.domain)}</strong><span>{numeric(item.pagesFetched)}/{numeric(item.pagesRequested)} {ar ? "صفحات" : "pages"}</span><p>{list(item.gaps).map((gap) => display(gap)).filter(Boolean).join(" · ") || (ar ? "لم تُحفظ فجوة لهذا النطاق." : "No crawl gap was saved for this domain.")}</p></article>)}</div>
        <div className="coverage-list gaps"><h3>{ar ? "فجوات التحقيق" : "Investigation gaps"}</h3>{gaps.slice(0, 30).map((gap) => <article key={gap.id}><strong>{display(gap.domain, ar ? "مصدر عام" : "Public source")}</strong><span>{display(gap.observedAt) && new Date(display(gap.observedAt)).toLocaleDateString(ar ? "ar" : "en")}</span><p>{display(gap.reason)}</p>{safeUrl(gap.url) && <a href={safeUrl(gap.url)} target="_blank" rel="noreferrer">{ar ? "افتح المصدر ↗" : "Open source ↗"}</a>}</article>)}</div>
      </>}
      </section>
    </div>
  </div>;
}

export default function StoredReportPage({ params }: { params: Promise<{ publicId: string }> | { publicId: string } }) {
  const [payload, setPayload] = useState<StoredPayload | null>(null); const [error, setError] = useState(""); const [localeOverride, setLocaleOverride] = useState<"en" | "ar" | null>(null);
  useEffect(() => { let current = true; Promise.resolve(params).then(({ publicId }) => fetch(`/api/reports/${publicId}`, { cache: "no-store" })).then(async (response) => ({ response, body: await response.json() as StoredPayload })).then(({ response, body }) => { if (!current) return; if (!response.ok || !body.ok) setError(body.error || "The saved report could not be opened."); else { setPayload(body); if (!body.report?.document && ["queued", "running"].includes(body.report?.run.status || "")) Promise.resolve(params).then(({ publicId }) => window.location.replace(`/reports/${publicId}/loading`)); } }).catch(() => current && setError("The saved report could not be opened.")); return () => { current = false; }; }, [params]);
  const report = payload?.report; const stored = report?.document; const document = stored?.document; const ar = localeOverride ? localeOverride === "ar" : report?.run.locale === "ar"; const dir = ar ? "rtl" : "ltr";
  if (error) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "التقرير غير متاح" : "Report unavailable"}</h1><p>{error}</p></main>;
  if (report && !document && ["failed", "interrupted"].includes(report.run.status)) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "توقف هذا التقرير" : "This report stopped"}</h1><p>{report.run.errorMessage || (ar ? "ابدأ تقريراً جديداً للمحاولة مرة أخرى." : "Start a fresh report to try again.")}</p></main>;
  if (!report || !document) return <main className="stored-report-state"><div className="route-spinner" /><p>Opening the saved market report…</p></main>;
  if (report.documentSchemaVersion !== 1) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "نسخة التقرير غير مدعومة" : "Unsupported report version"}</h1></main>;
  return <main className="stored-report-page" lang={ar ? "ar" : "en"} dir={dir}><ReportWorkspace blocks={document.blocks} marketBrief={object(stored?.marketBrief)} primaryDomain={report.run.primaryDomain} observedAt={report.run.updatedAt} reportStatus={report.run.status} ar={ar} onToggleLocale={() => setLocaleOverride(ar ? "en" : "ar")} /></main>;
}
