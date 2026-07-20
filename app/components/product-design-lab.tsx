"use client";

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { PricePosition } from "./price-position";
import { resolvedPriceDelta } from "../lib/report-presentation";

export type ProductBattle = {
  primary: Record<string, unknown>;
  rival: Record<string, unknown>;
  match: Record<string, unknown>;
  key: string;
};

type ProductLayout = "table" | "matchups" | "opportunities";
type ProductDesignLabProps = {
  comparison?: Record<string, unknown>;
  battles: ProductBattle[];
  primaryDomain: string;
  observedAt: string;
  ar: boolean;
};

const LAYOUTS: ProductLayout[] = ["table", "matchups", "opportunities"];
const LAYOUT_LABELS: Record<ProductLayout, { en: string; ar: string }> = {
  table: { en: "Table", ar: "جدول" },
  matchups: { en: "Matchups", ar: "مواجهات" },
  opportunities: { en: "Opportunities", ar: "فرص" },
};

function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown) { return Array.isArray(value) ? value : []; }
function repairEncoding(value: string) {
  if (!/(?:Ãƒ|Ã‚|Ã˜|Ã™|Ã¢)/.test(value)) return value;
  try {
    const bytes = Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return repaired.includes("�") ? value : repaired;
  } catch { return value; }
}
function display(value: unknown, fallback = "") { return repairEncoding(typeof value === "string" ? value : "").replace(/&ndash;/g, "–").replace(/&amp;/g, "&").trim() || fallback; }
function safeUrl(value: unknown) { const url = display(value); return /^https?:\/\/[^\s]+$/i.test(url) ? url : ""; }
function slug(value: unknown) { return display(value, "item").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "item"; }
function viewHref(view: string, anchor = "") { return `?view=${view}${anchor ? `#${anchor}` : ""}`; }
function productPrice(product: Record<string, unknown>) { return list(product.priceSignals).map((item) => display(object(item).raw)).filter(Boolean)[0] || ""; }
function conciseAction(value: unknown, fallback: string, limit = 96) {
  const full = display(value, fallback);
  const firstSentence = full.match(/^.*?[.!?؟](?:\s|$)/)?.[0]?.trim() || "";
  const sentence = firstSentence.length >= 15 ? firstSentence : full;
  if (sentence.length <= limit) return sentence;
  const clipped = sentence.slice(0, limit - 1).replace(/\s+\S*$/, "").trim();
  return `${clipped || sentence.slice(0, limit - 1).trim()}…`;
}
function productLayoutFromLocation(): ProductLayout {
  const value = new URLSearchParams(window.location.search).get("layout");
  return LAYOUTS.includes(value as ProductLayout) ? value as ProductLayout : "table";
}
function csvCell(value: unknown) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }

type ProductRow = ReturnType<typeof prepareRow>;

function prepareRow(battle: ProductBattle, ar: boolean) {
  const domain = display(battle.match.domain || battle.rival.domain);
  const assessment = object(battle.match.assessment);
  const decision = object(battle.match.decision);
  const primaryPrice = productPrice(battle.primary);
  const rivalPrice = productPrice(battle.rival);
  const comparablePrice = resolvedPriceDelta(decision.priceComparison);
  const primaryDisplay = comparablePrice?.primaryRaw || primaryPrice;
  const rivalDisplay = comparablePrice?.rivalRaw || rivalPrice;
  const primarySource = safeUrl(battle.primary.sourceUrl);
  const rivalSource = safeUrl(battle.rival.sourceUrl);
  const reasons = list(assessment.reasons).map((value) => display(value)).filter(Boolean).join(" · ") || list(battle.match.sharedTerms).map((value) => display(value)).filter(Boolean).join(" · ");
  const verdict = display(assessment.verdict, ar ? "بديل قريب" : "Close substitute");
  const fullAction = display(decision.recommendedMove, ar ? "راجع المنتجين قبل اتخاذ قرار." : "Review both products before acting.");
  const shortAction = conciseAction(fullAction, ar ? "راجع المنتجين قبل اتخاذ قرار." : "Review both products before acting.");
  const priceStatus = comparablePrice ? "comparable" : primaryDisplay && rivalDisplay ? "basis-unverified" : primaryDisplay || rivalDisplay ? "one-price" : "no-prices";
  const priceSignal = comparablePrice
    ? comparablePrice.equal
      ? (ar ? "نفس السعر المرصود" : "Same observed price")
      : comparablePrice.percent < 0
        ? (ar ? `المنافس أرخص بنسبة ${Math.abs(comparablePrice.percent)}%` : `Rival is ${Math.abs(comparablePrice.percent)}% cheaper`)
        : (ar ? `أنت أرخص بنسبة ${comparablePrice.percent}%` : `You are ${comparablePrice.percent}% cheaper`)
    : priceStatus === "basis-unverified"
      ? (ar ? "الأسعار موجودة — أساس المقارنة غير مؤكد" : "Prices found — comparison basis unverified")
      : priceStatus === "one-price"
        ? (ar ? "تم العثور على سعر عام واحد فقط" : "Only one public price found")
        : (ar ? "لم يتم العثور على أسعار عامة" : "No public prices found");
  const lane = comparablePrice ? comparablePrice.percent < 0 ? "pressure" : "advantage" : "evidence";
  const claimType = display(assessment.claimType, "inferred").toLowerCase();
  const confidence = display(battle.match.confidence, ar ? "ثقة محدودة" : "Limited confidence");
  return { battle, domain, assessment, decision, primaryDisplay, rivalDisplay, primarySource, rivalSource, reasons, verdict, fullAction, shortAction, comparablePrice, priceStatus, priceSignal, lane, claimType, confidence };
}

function ProductIdentity({ role, product, price, source, domain, ar, compact = false }: { role: "you" | "rival"; product: Record<string, unknown>; price: string; source: string; domain?: string; ar: boolean; compact?: boolean }) {
  const name = display(product.name, role === "you" ? (ar ? "منتج مرصود" : "Observed product") : (ar ? "منتج منافس مرصود" : "Observed rival product"));
  const image = safeUrl(product.imageUrl);
  return <div className={`lab-product ${compact ? "compact" : ""}`}>
    {image && <img src={image} alt="" />}
    <div><span>{role === "you" ? (ar ? "منتجك" : "YOU") : domain || (ar ? "المنافس" : "RIVAL")}</span><strong dir="auto">{name}</strong><b className={price ? "observed" : "unavailable"} dir="auto">{price || (ar ? "السعر غير مرصود" : "Price not observed")}</b>{source && <a href={source} target="_blank" rel="noreferrer">{ar ? "افتح المنتج ↗" : "Open product ↗"}</a>}</div>
  </div>;
}

function MatchDetails({ row, observedAt, ar }: { row: ProductRow; observedAt: string; ar: boolean }) {
  return <details className="product-match-details"><summary>{ar ? "لماذا هذه المطابقة؟" : "Why this match?"}</summary><div>
    <section><span>{ar ? "أساس المطابقة" : "MATCH BASIS"}</span><strong>{row.verdict.replace(/_/g, " ")}</strong><p>{row.reasons || (ar ? "لم تُحفظ أسباب إضافية." : "No additional match reasons were saved.")}</p></section>
    <section><span>{ar ? "حالة الدليل" : "EVIDENCE STATE"}</span><strong>{row.claimType} · {row.confidence}</strong><p>{ar ? "لوحظ" : "Observed"} {new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</p></section>
    <section><span>{ar ? "المصادر" : "SOURCES"}</span><div className="product-detail-links">{row.primarySource && <a href={row.primarySource} target="_blank" rel="noreferrer">{ar ? "مصدر منتجك ↗" : "Your source ↗"}</a>}{row.rivalSource && <a href={row.rivalSource} target="_blank" rel="noreferrer">{ar ? "مصدر المنافس ↗" : "Rival source ↗"}</a>}<a href={viewHref("evidence", `evidence-${slug(row.domain)}`)}>{ar ? "دفتر الأدلة" : "Evidence ledger"}</a></div></section>
  </div></details>;
}

export function ProductDesignLab({ comparison, battles, primaryDomain, observedAt, ar }: ProductDesignLabProps) {
  const [layout, setLayout] = useState<ProductLayout>("table");
  const [shareStatus, setShareStatus] = useState("");
  const [shareFallback, setShareFallback] = useState("");
  const layoutTabs = useRef<Array<HTMLButtonElement | null>>([]);
  const rows = useMemo(() => battles.map((battle) => prepareRow(battle, ar)), [battles, ar]);
  const enrichmentGaps = list(object(comparison?.enrichment).gaps).map(object);

  useEffect(() => {
    const sync = () => {
      const next = productLayoutFromLocation(); setLayout(next);
      const url = new URL(window.location.href);
      if (url.searchParams.get("layout") !== next) { url.searchParams.set("layout", next); window.history.replaceState({}, "", url); }
    };
    sync(); window.addEventListener("popstate", sync); return () => window.removeEventListener("popstate", sync);
  }, []);

  const selectLayout = (next: ProductLayout) => {
    const url = new URL(window.location.href); url.searchParams.set("view", "products"); url.searchParams.set("layout", next); url.hash = "";
    window.history.pushState({}, "", url); setLayout(next); setShareStatus(""); setShareFallback("");
  };
  const onLayoutKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === (ar ? "ArrowLeft" : "ArrowRight") ? (index + 1) % LAYOUTS.length : event.key === (ar ? "ArrowRight" : "ArrowLeft") ? (index - 1 + LAYOUTS.length) % LAYOUTS.length : event.key === "Home" ? 0 : event.key === "End" ? LAYOUTS.length - 1 : -1;
    if (next < 0) return; event.preventDefault(); layoutTabs.current[next]?.focus(); selectLayout(LAYOUTS[next]);
  };
  const reportUrl = () => { const url = new URL(window.location.href); url.searchParams.set("view", "products"); url.searchParams.set("layout", layout); url.hash = ""; return url.toString(); };
  const rowAnchor = (row: ProductRow, index: number) => rows.findIndex((candidate) => candidate.domain === row.domain) === index ? `rival-${slug(row.domain)}` : `rival-${slug(row.domain)}-${slug(row.battle.key)}`;
  const copyText = async (value: string) => {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; } } catch { /* Use the selection fallback. */ }
    const input = document.createElement("textarea"); input.value = value; input.setAttribute("readonly", ""); input.style.position = "fixed"; input.style.opacity = "0"; document.body.appendChild(input); input.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { input.remove(); }
  };
  const shareReport = async () => {
    const url = reportUrl(); setShareFallback("");
    try {
      if (navigator.share) { await navigator.share({ title: `${primaryDomain} — Market Signal products`, text: ar ? "مقارنة المنتجات المحفوظة" : "Saved product comparison", url }); setShareStatus(ar ? "تمت المشاركة" : "Shared"); return; }
    } catch (error) { if (error instanceof DOMException && error.name === "AbortError") { setShareStatus(ar ? "تم إلغاء المشاركة" : "Share canceled"); return; } }
    if (await copyText(url)) setShareStatus(ar ? "تم نسخ الرابط" : "Link copied"); else { setShareStatus(ar ? "انسخ الرابط أدناه" : "Copy the link below"); setShareFallback(url); }
  };
  const exportCsv = () => {
    const headers = ["your_product", "your_price_raw", "your_price_amount", "your_currency", "rival_domain", "rival_product", "rival_price_raw", "rival_price_amount", "rival_currency", "price_status", "price_signal", "suggested_action", "match_status", "confidence", "observed_at", "your_source", "rival_source"];
    const data = rows.map((row) => [display(row.battle.primary.name), row.primaryDisplay, row.comparablePrice?.primary.amount ?? "", row.comparablePrice?.primary.currency ?? "", row.domain, display(row.battle.rival.name), row.rivalDisplay, row.comparablePrice?.rival.amount ?? "", row.comparablePrice?.rival.currency ?? "", row.priceStatus, row.comparablePrice ? row.priceSignal : "", row.fullAction, `${row.verdict ? "accepted" : "unverified"}-${row.claimType}`, row.confidence, observedAt, row.primarySource, row.rivalSource]);
    const csv = `\uFEFF${[headers, ...data].map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = href; anchor.download = `${slug(primaryDomain)}-product-comparison.csv`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  const lanes = [
    { id: "pressure", title: ar ? "ضغط سعري" : "Price pressure", description: ar ? "المنافس أرخص على أساس قابل للمقارنة." : "The rival is cheaper on a comparable basis." },
    { id: "advantage", title: ar ? "تفوقك السعري" : "Your edge", description: ar ? "أنت أرخص أو عند تعادل السعر المرصود." : "You lead or hold observed price parity." },
    { id: "evidence", title: ar ? "يحتاج إلى دليل" : "Needs evidence", description: ar ? "الأسعار مفقودة أو أساس المقارنة غير مؤكد." : "Prices are missing or the comparison basis is unverified." },
  ] as const;

  return <>
    <header className="panel-intro compact product-lab-intro"><div><span>{ar ? "مقارنة منتج بمنتج" : "PRODUCT VS PRODUCT"}</span><h2>{ar ? "اختر الطريقة الأسهل لرؤية المنافسة" : "Choose the clearest way to see the competition"}</h2><p>{ar ? "ثلاث طرق عرض، ونفس البيانات العامة المحفوظة." : "Three views, one saved set of public evidence."}</p></div></header>
    <div className="panel-metrics"><div><strong>{rows.length}</strong><span>{ar ? "مطابقات مقبولة" : "accepted matches"}</span></div><div><strong>{rows.filter((row) => row.comparablePrice).length}</strong><span>{ar ? "فروق سعر مباشرة" : "direct price deltas"}</span></div><div><strong>{list(comparison?.rows).length}</strong><span>{ar ? "منتجاتك التي تم تقييمها" : "your products assessed"}</span></div></div>
    <div className="product-layout-toolbar">
      <div className="product-layout-tabs" role="tablist" aria-label={ar ? "طرق عرض مقارنة المنتجات" : "Product comparison layouts"}>{LAYOUTS.map((item, index) => <button id={`product-layout-tab-${item}`} key={item} ref={(node) => { layoutTabs.current[index] = node; }} type="button" role="tab" aria-selected={layout === item} aria-controls={`product-layout-${item}`} tabIndex={layout === item ? 0 : -1} onClick={() => selectLayout(item)} onKeyDown={(event) => onLayoutKey(event, index)}><span>{String(index + 1).padStart(2, "0")}</span>{LAYOUT_LABELS[item][ar ? "ar" : "en"]}</button>)}</div>
      <div className="product-lab-actions"><button type="button" onClick={exportCsv}>{ar ? "تصدير CSV" : "Export CSV"}</button><button type="button" onClick={shareReport}>{ar ? "مشاركة" : "Share"}</button></div>
    </div>
    {(shareStatus || shareFallback) && <div className="product-share-status" role="status" aria-live="polite"><span>{shareStatus}</span>{shareFallback && <input value={shareFallback} readOnly onFocus={(event) => event.currentTarget.select()} aria-label={ar ? "رابط التقرير" : "Report link"} />}</div>}
    {enrichmentGaps.length > 0 && <div className="product-evidence-gaps" role="status"><header><span>{ar ? "فجوة بيانات المنتج" : "PRODUCT DATA GAP"}</span><strong>{ar ? `تعذر إكمال ${enrichmentGaps.length} صفحة محددة` : `${enrichmentGaps.length} selected page${enrichmentGaps.length === 1 ? "" : "s"} could not be completed`}</strong></header>{enrichmentGaps.slice(0, 4).map((gap, index) => <p key={`${display(gap.productId)}-${index}`}><b>{display(gap.role, ar ? "منتج" : "product")}</b><span>{display(gap.reason, ar ? "لم تتوفر أدلة كافية للسعر أو الصورة." : "Price or image evidence was not available from this page.")}</span>{safeUrl(gap.url) && <a href={safeUrl(gap.url)} target="_blank" rel="noreferrer">{ar ? "افتح المصدر ↗" : "Open source ↗"}</a>}</p>)}</div>}

    {layout === "table" && <section id="product-layout-table" role="tabpanel" aria-labelledby="product-layout-tab-table" className="product-layout-panel product-table-layout">
      <div className="product-compact-table-shell"><table className="product-compact-table"><thead><tr><th>{ar ? "منتجك" : "Your product"}</th><th>{ar ? "المنافس" : "Closest rival"}</th><th>{ar ? "إشارة السعر" : "Price signal"}</th><th>{ar ? "الخطوة التالية" : "Next move"}</th></tr></thead>{rows.map((row, index) => <tbody key={row.battle.key}><tr id={rowAnchor(row, index)}><td><ProductIdentity role="you" product={row.battle.primary} price={row.primaryDisplay} source={row.primarySource} ar={ar} compact /></td><td><ProductIdentity role="rival" product={row.battle.rival} price={row.rivalDisplay} source={row.rivalSource} domain={row.domain} ar={ar} compact /></td><td><span className={`product-signal ${row.lane}`}>{row.priceSignal}</span></td><td><strong className="product-next-move">{row.shortAction}</strong></td></tr><tr className="product-table-detail"><td colSpan={4}><MatchDetails row={row} observedAt={observedAt} ar={ar} /></td></tr></tbody>)}</table></div>
    </section>}

    {layout === "matchups" && <section id="product-layout-matchups" role="tabpanel" aria-labelledby="product-layout-tab-matchups" className="product-layout-panel matchup-layout"><ul>{rows.map((row, index) => <li key={row.battle.key} id={rowAnchor(row, index)}><div className="matchup-products"><ProductIdentity role="you" product={row.battle.primary} price={row.primaryDisplay} source={row.primarySource} ar={ar} /><span aria-hidden="true">VS</span><ProductIdentity role="rival" product={row.battle.rival} price={row.rivalDisplay} source={row.rivalSource} domain={row.domain} ar={ar} /></div><div className="matchup-decision"><PricePosition comparisonValue={row.decision.priceComparison} primaryRaw={row.primaryDisplay} rivalRaw={row.rivalDisplay} priceVerdict={display(row.decision.priceVerdict)} locale={ar ? "ar" : "en"} showDetail={false} showValues={false} /><section><span>{ar ? "الخطوة التالية" : "NEXT MOVE"}</span><strong>{row.shortAction}</strong></section></div><MatchDetails row={row} observedAt={observedAt} ar={ar} /></li>)}</ul></section>}

    {layout === "opportunities" && <section id="product-layout-opportunities" role="tabpanel" aria-labelledby="product-layout-tab-opportunities" className="product-layout-panel opportunity-layout"><div className="opportunity-lanes">{lanes.map((lane) => { const items = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.lane === lane.id); return <section className={`opportunity-lane ${lane.id}`} aria-labelledby={`lane-${lane.id}`} key={lane.id}><header><div><h3 id={`lane-${lane.id}`}>{lane.title}</h3><p>{lane.description}</p></div><b>{items.length}</b></header><ul>{items.map(({ row, index }) => <li key={row.battle.key} id={rowAnchor(row, index)}><span>{row.domain}</span><div className="opportunity-pair"><strong dir="auto">{display(row.battle.primary.name)}</strong><i aria-hidden="true">→</i><strong dir="auto">{display(row.battle.rival.name)}</strong></div><div className="opportunity-prices"><b dir="auto">{row.primaryDisplay || (ar ? "سعرك غير مرصود" : "Your price not observed")}</b><b dir="auto">{row.rivalDisplay || (ar ? "سعر المنافس غير مرصود" : "Rival price not observed")}</b></div><p className="opportunity-signal">{row.priceSignal}</p><strong className="opportunity-action">{row.shortAction}</strong><MatchDetails row={row} observedAt={observedAt} ar={ar} /></li>)}</ul>{!items.length && <div className="opportunity-empty">{ar ? "لا توجد أزواج في هذه الفئة." : "No pairs in this group."}</div>}</section>; })}</div></section>}

    {!rows.length && <div className="truth-state limited"><strong>{ar ? "لا توجد مطابقة منتجات موثقة" : "No defensible product match was saved"}</strong><p>{ar ? "تم فحص الكتالوج، لكن لا ينبغي عرض زوج ضعيف على أنه مقارنة." : "Catalogs were assessed, but a weak pair should not be presented as a comparison."}</p></div>}
  </>;
}
