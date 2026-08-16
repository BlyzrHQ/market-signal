"use client";

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { PricePosition } from "./price-position";
import { formatPriceClaim, resolvePriceClaim } from "../lib/price-claims";
import { jsonResponseErrorMessage, readJsonResponse } from "../lib/json-response";

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
  primaryProducts?: { authoritative: boolean; totalCount: number; products: Array<Record<string, unknown>>; truncated: boolean };
  publicId: string;
  authoritativeMatchTotal?: number;
  onAuthoritativeSummary?: (summary: { totalCount: number; domainCounts: Record<string, number> }) => void;
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
function numeric(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
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
function productPrice(product: Record<string, unknown>) {
  const signals = list(product.priceSignals).map(object);
  const priced = signals.flatMap((signal) => typeof signal.amount === "number" && display(signal.currency) ? [{ amount: signal.amount, currency: display(signal.currency) }] : []);
  const currencies = [...new Set(priced.map((item) => item.currency))];
  const amounts = [...new Set(priced.map((item) => item.amount))].sort((left, right) => left - right);
  if (currencies.length === 1 && amounts.length > 1) return `${currencies[0]} ${amounts[0]}–${amounts.at(-1)}`;
  return signals.map((item) => display(item.raw)).filter(Boolean)[0] || "";
}
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
  const actionPlan = object(decision.actionPlan);
  const primaryPrice = productPrice(battle.primary);
  const rivalPrice = productPrice(battle.rival);
  const priceClaim = resolvePriceClaim({
    comparisonValue: decision.priceComparison,
    primaryRaw: primaryPrice,
    rivalRaw: rivalPrice,
    primaryQuantity: battle.primary.quantity,
    rivalQuantity: battle.rival.quantity,
  });
  const priceCopy = formatPriceClaim(priceClaim, ar ? "ar" : "en");
  const primaryDisplay = priceClaim.primaryRaw || primaryPrice;
  const rivalDisplay = priceClaim.rivalRaw || rivalPrice;
  const primarySource = safeUrl(battle.primary.sourceUrl);
  const rivalSource = safeUrl(battle.rival.sourceUrl);
  const reasons = list(assessment.reasons).map((value) => display(value)).filter(Boolean).join(" · ") || list(battle.match.sharedTerms).map((value) => display(value)).filter(Boolean).join(" · ");
  const verdict = display(assessment.verdict, ar ? "بديل قريب" : "Close substitute");
  const actionEn = display(actionPlan.actionEn, display(decision.recommendedMove));
  const actionAr = display(actionPlan.actionAr, actionEn);
  const fullAction = display(ar ? actionAr : actionEn, ar ? "راجع المنتجين قبل اتخاذ قرار." : "Review both products before acting.");
  const shortAction = conciseAction(fullAction, ar ? "راجع المنتجين قبل اتخاذ قرار." : "Review both products before acting.");
  const actionRationale = display(ar ? actionPlan.rationaleAr : actionPlan.rationaleEn, display(decision.whyTheyMayWin));
  const actionSource = actionPlan.source === "ai" ? "ai" : "deterministic";
  const actionModel = display(actionPlan.model);
  const actionPromptVersion = display(actionPlan.promptVersion);
  const actionEvidenceKeys = list(actionPlan.evidenceKeys).map((value) => display(value)).filter(Boolean);
  const priceStatus = priceClaim.kind;
  const priceSignal = priceCopy.headline;
  const priceDetail = priceCopy.supporting || priceCopy.detail;
  const lane = priceCopy.lane;
  const claimType = display(assessment.claimType, "inferred").toLowerCase();
  const confidence = display(battle.match.confidence, ar ? "ثقة محدودة" : "Limited confidence");
  const matchConfidence = display(battle.match.confidence);
  const matchStatus = matchConfidence && matchConfidence !== "Low" ? "accepted" : "limited";
  return { battle, domain, assessment, decision, primaryDisplay, rivalDisplay, primarySource, rivalSource, reasons, verdict, fullAction, shortAction, actionRationale, actionSource, actionModel, actionPromptVersion, actionEvidenceKeys, priceClaim, priceStatus, priceSignal, priceDetail, lane, claimType, confidence, matchStatus };
}

function ProductIdentity({ role, product, price, source, domain, ar, compact = false, showPrice = true }: { role: "you" | "rival"; product: Record<string, unknown>; price: string; source: string; domain?: string; ar: boolean; compact?: boolean; showPrice?: boolean }) {
  const name = display(product.name, role === "you" ? (ar ? "منتج مرصود" : "Observed product") : (ar ? "منتج منافس مرصود" : "Observed rival product"));
  const image = safeUrl(product.imageUrl);
  return <div className={`lab-product ${compact ? "compact" : ""}`}>
    {image && <img src={image} alt="" />}
    <div><span>{role === "you" ? (ar ? "منتجك" : "YOU") : domain || (ar ? "المنافس" : "RIVAL")}</span><strong dir="auto">{name}</strong>{showPrice && <b className={price ? "observed" : "unavailable"} dir="auto">{price || (ar ? "السعر غير مرصود" : "Price not observed")}</b>}{source && <a href={source} target="_blank" rel="noreferrer">{ar ? "افتح المنتج ↗" : "Open product ↗"}</a>}</div>
  </div>;
}

function MatchDetails({ row, observedAt, ar }: { row: ProductRow; observedAt: string; ar: boolean }) {
  return <details className="product-match-details"><summary>{ar ? "لماذا هذه المطابقة؟" : "Why this match?"}</summary><div>
    <section><span>{ar ? "أساس المطابقة" : "MATCH BASIS"}</span><strong>{row.verdict.replace(/_/g, " ")}</strong><p>{row.reasons || (ar ? "لم تُحفظ أسباب إضافية." : "No additional match reasons were saved.")}</p></section>
    <section><span>{ar ? "سبب الخطوة" : "ACTION RATIONALE"}</span><strong>{row.actionSource === "ai" ? (ar ? "توصية صاغها الذكاء الاصطناعي" : "AI-drafted recommendation") : (ar ? "توصية قائمة على القواعد" : "Rule-based recommendation")}</strong><p>{row.actionRationale || row.fullAction}</p>{row.actionSource === "ai" && <small>{[row.actionModel, row.actionPromptVersion].filter(Boolean).join(" · ")}</small>}</section>
    <section><span>{ar ? "حالة الدليل" : "EVIDENCE STATE"}</span><strong>{row.claimType} · {row.confidence}</strong><p>{ar ? "لوحظ" : "Observed"} {new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</p></section>
    <section><span>{ar ? "المصادر" : "SOURCES"}</span><div className="product-detail-links">{row.primarySource && <a href={row.primarySource} target="_blank" rel="noreferrer">{ar ? "مصدر منتجك ↗" : "Your source ↗"}</a>}{row.rivalSource && <a href={row.rivalSource} target="_blank" rel="noreferrer">{ar ? "مصدر المنافس ↗" : "Rival source ↗"}</a>}</div></section>
  </div></details>;
}

function ProductTablePrice({ value, ar }: { value: string; ar: boolean }) {
  return <strong className={`product-table-price ${value ? "observed" : "unavailable"}`} dir="auto">{value || (ar ? "غير مرصود" : "Not observed")}</strong>;
}

function ProductTableDetails({ row, observedAt, ar }: { row: ProductRow; observedAt: string; ar: boolean }) {
  return <details className="product-row-details">
    <summary>{ar ? "لماذا هذه المطابقة؟" : "Why this match?"}</summary>
    <div>
      <p><b>{ar ? "السبب" : "Match reason"}</b><span>{row.reasons || (ar ? "لم تُحفظ أسباب إضافية." : "No additional match reasons were saved.")}</span></p>
      <p><b>{ar ? "سبب الخطوة" : "Action rationale"}</b><span>{row.actionRationale || row.fullAction}</span></p>
      <p><b>{ar ? "مصدر التوصية" : "Recommendation source"}</b><span>{row.actionSource === "ai" ? `${ar ? "ذكاء اصطناعي مقيّد بالأدلة" : "Evidence-grounded AI"}${row.actionModel ? ` · ${row.actionModel}` : ""}${row.actionPromptVersion ? ` · ${row.actionPromptVersion}` : ""}` : (ar ? "قواعد حتمية" : "Deterministic rules")}</span></p>
      {row.actionEvidenceKeys.length > 0 && <p><b>{ar ? "الأدلة المستخدمة" : "Evidence used"}</b><span>{row.actionEvidenceKeys.join(" · ")}</span></p>}
      <p><b>{ar ? "حالة الدليل" : "Evidence state"}</b><span>{row.verdict.replace(/_/g, " ")} · {row.claimType} · {row.confidence}</span></p>
      <p><b>{ar ? "لوحظ" : "Observed"}</b><time dateTime={observedAt}>{new Date(observedAt).toLocaleDateString(ar ? "ar" : "en")}</time></p>
    </div>
  </details>;
}

type MatchPagePayload = { ok: boolean; error?: string; errorCode?: string; page?: { authoritative: true; manifestHash: string; totalCount: number; directPriceCount: number; domainCounts: Record<string, number>; items: ProductBattle[]; nextCursor: string | null } };

export function ProductDesignLab({ comparison, battles, primaryProducts, publicId, authoritativeMatchTotal, onAuthoritativeSummary, primaryDomain, observedAt, ar }: ProductDesignLabProps) {
  const [layout, setLayout] = useState<ProductLayout>("table");
  const [shareStatus, setShareStatus] = useState("");
  const [shareFallback, setShareFallback] = useState("");
  const [authoritativeBattles, setAuthoritativeBattles] = useState<ProductBattle[] | null>(null);
  const [matchTotal, setMatchTotal] = useState(authoritativeMatchTotal || battles.length);
  const [directPriceTotal, setDirectPriceTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [matchLoadState, setMatchLoadState] = useState<"loading" | "ready" | "fallback" | "more" | "exporting">("loading");
  const [matchLoadMessage, setMatchLoadMessage] = useState("");
  const layoutTabs = useRef<Array<HTMLButtonElement | null>>([]);
  const displayedBattles = authoritativeBattles ?? battles;
  const rows = useMemo(() => displayedBattles.map((battle) => prepareRow(battle, ar)), [displayedBattles, ar]);
  const catalogProducts = primaryProducts?.authoritative ? primaryProducts.products : [];
  const assessedProducts = numeric(object(comparison?.matching).primaryProductsAssessed) || list(comparison?.rows).length;
  const excludedPriceMatches = numeric(object(object(comparison?.matching).publication).suppressedAcceptedPairs);

  const fetchMatchPage = async (cursor?: string) => {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`/api/reports/${publicId}/matches?${query}`, { headers: { accept: "application/json" } });
    const body = await readJsonResponse<MatchPagePayload>(response, "Saved report matches");
    if (!response.ok || !body.ok || !body.page?.authoritative) throw Object.assign(new Error(body.error || "The complete saved matches are unavailable."), { fallback: body.errorCode === "facts-unavailable" || response.status === 409 });
    return body.page;
  };

  useEffect(() => {
    let current = true;
    fetchMatchPage().then((page) => {
      if (!current) return;
      setAuthoritativeBattles(page.items); setMatchTotal(page.totalCount); setDirectPriceTotal(page.directPriceCount); setNextCursor(page.nextCursor); setMatchLoadState("ready"); onAuthoritativeSummary?.({ totalCount: page.totalCount, domainCounts: page.domainCounts || {} });
    }).catch((cause) => {
      if (!current) return;
      setMatchLoadState("fallback"); setMatchLoadMessage(jsonResponseErrorMessage(cause, "The compact saved comparison remains available."));
    });
    return () => { current = false; };
  // The public report id identifies an immutable completed fact manifest.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId, onAuthoritativeSummary]);

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
  const loadMoreMatches = async () => {
    if (!nextCursor || matchLoadState === "more" || matchLoadState === "exporting") return;
    setMatchLoadState("more"); setMatchLoadMessage("");
    try {
      const page = await fetchMatchPage(nextCursor);
      setAuthoritativeBattles((current) => [...(current || []), ...page.items]); setNextCursor(page.nextCursor); setMatchTotal(page.totalCount); setDirectPriceTotal(page.directPriceCount); setMatchLoadState("ready");
    } catch (cause) {
      setMatchLoadState("ready"); setMatchLoadMessage(jsonResponseErrorMessage(cause, "More saved matches could not be loaded."));
    }
  };
  const exportCsv = async () => {
    let exportBattles = authoritativeBattles ?? battles;
    let cursor = nextCursor;
    if (authoritativeBattles && cursor) {
      setMatchLoadState("exporting"); setMatchLoadMessage("");
      try {
        while (cursor) {
          const page = await fetchMatchPage(cursor);
          exportBattles = [...exportBattles, ...page.items]; cursor = page.nextCursor;
        }
        setAuthoritativeBattles(exportBattles); setNextCursor(null); setMatchLoadState("ready");
      } catch (cause) {
        setMatchLoadState("ready"); setMatchLoadMessage(jsonResponseErrorMessage(cause, "The complete CSV could not be prepared.")); return;
      }
    }
    const exportRows = exportBattles.map((battle) => prepareRow(battle, ar));
    const headers = ["your_product", "your_price_raw", "your_price_amount", "your_currency", "rival_domain", "rival_product", "rival_price_raw", "rival_price_amount", "rival_currency", "price_status", "price_signal", "suggested_action", "suggested_action_source", "match_status", "confidence", "observed_at", "your_source", "rival_source"];
    const data = exportRows.map((row) => [display(row.battle.primary.name), row.primaryDisplay, row.priceClaim.primary?.amount ?? "", row.priceClaim.primary?.currency ?? "", row.domain, display(row.battle.rival.name), row.rivalDisplay, row.priceClaim.rival?.amount ?? "", row.priceClaim.rival?.currency ?? "", row.priceStatus, row.priceSignal, row.fullAction, row.actionSource, `${row.matchStatus}-${row.claimType}`, row.confidence, observedAt, row.primarySource, row.rivalSource]);
    const csv = `\uFEFF${[headers, ...data].map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = href; anchor.download = `${slug(primaryDomain)}-product-comparison.csv`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  const lanes = [
    { id: "pressure", title: ar ? "ضغط سعري" : "Price pressure", description: ar ? "المنافس يتقدم بسعر مباشر أو بسعر وحدة محسوب." : "The rival leads on a direct or computed unit-price basis." },
    { id: "advantage", title: ar ? "تفوقك السعري" : "Your edge", description: ar ? "أنت تتقدم بسعر مباشر أو بسعر وحدة محسوب." : "You lead on a direct or computed unit-price basis." },
    { id: "evidence", title: ar ? "يحتاج إلى دليل" : "Needs evidence", description: ar ? "نعرض فرق السعر المعروض مع حجب الادعاء غير المدعوم." : "Listed-price gaps stay visible while unsupported equivalence claims are withheld." },
  ] as const;

  return <>
    <header className="panel-intro compact product-lab-intro"><div><span>{ar ? "مقارنة منتج بمنتج" : "PRODUCT VS PRODUCT"}</span><h2>{ar ? "اختر الطريقة الأسهل لرؤية المنافسة" : "Choose the clearest way to see the competition"}</h2><p>{ar ? "ثلاث طرق عرض، ونفس البيانات العامة المحفوظة." : "Three views, one saved set of public evidence."}</p></div></header>
    <div className="panel-metrics"><div><strong>{authoritativeBattles ? matchTotal : rows.length}</strong><span>{ar ? "مطابقات مقبولة محفوظة" : "accepted matches saved"}</span></div><div><strong>{directPriceTotal ?? rows.filter((row) => row.priceClaim.kind === "direct").length}</strong><span>{ar ? "فروق سعر مباشرة" : "direct price deltas"}</span></div><div><strong>{assessedProducts}</strong><span>{ar ? "منتجاتك التي تم تقييمها فعلياً" : "your products actually assessed"}</span></div></div>
    <div className={`product-result-coverage ${matchLoadState === "fallback" ? "limited" : "ready"}`} role="status" aria-live="polite"><span>{matchLoadState === "loading" ? (ar ? "جارٍ تحميل النتائج الكاملة…" : "Loading complete saved results…") : authoritativeBattles ? (ar ? `نعرض ${rows.length} من ${matchTotal} مطابقة محفوظة عبر ${assessedProducts} منتجاً تم تقييمه.` : `Showing ${rows.length} of ${matchTotal} saved matches across ${assessedProducts} products actually assessed.`) : (ar ? `نعرض لقطة مضغوطة من ${rows.length} مطابقة.` : `Showing a compact snapshot of ${rows.length} matches.`)}</span>{matchLoadMessage && <small>{matchLoadMessage}</small>}</div>
    {excludedPriceMatches > 0 && <div className="product-result-coverage limited" role="note"><span>{ar ? `تم الاحتفاظ بأدلة ${excludedPriceMatches} مطابقة أخرى، لكنها مستبعدة من جدول الأسعار لعدم توفر سعرين عامين صالحين بالعملة نفسها.` : `${excludedPriceMatches} additional semantic matches were preserved as evidence but excluded from the price table because two valid public prices in the same currency were unavailable.`}</span></div>}
    <div className="product-layout-toolbar">
      <div className="product-layout-tabs" role="tablist" aria-label={ar ? "طرق عرض مقارنة المنتجات" : "Product comparison layouts"}>{LAYOUTS.map((item, index) => <button id={`product-layout-tab-${item}`} key={item} ref={(node) => { layoutTabs.current[index] = node; }} type="button" role="tab" aria-selected={layout === item} aria-controls={`product-layout-${item}`} tabIndex={layout === item ? 0 : -1} onClick={() => selectLayout(item)} onKeyDown={(event) => onLayoutKey(event, index)}><span>{String(index + 1).padStart(2, "0")}</span>{LAYOUT_LABELS[item][ar ? "ar" : "en"]}</button>)}</div>
      <div className="product-lab-actions"><button type="button" onClick={exportCsv} disabled={matchLoadState === "loading" || matchLoadState === "more" || matchLoadState === "exporting"}>{matchLoadState === "exporting" ? (ar ? "جارٍ تجهيز كل النتائج…" : "Preparing all results…") : (ar ? "تصدير CSV" : "Export CSV")}</button><button type="button" onClick={shareReport}>{ar ? "مشاركة" : "Share"}</button></div>
    </div>
    {authoritativeBattles && nextCursor && <div className="product-load-more"><button type="button" onClick={loadMoreMatches} disabled={matchLoadState === "more" || matchLoadState === "exporting"}>{matchLoadState === "more" ? (ar ? "جارٍ التحميل…" : "Loading…") : (ar ? `تحميل المزيد (${matchTotal - rows.length} متبقية)` : `Load more (${matchTotal - rows.length} remaining)`)}</button></div>}
    {(shareStatus || shareFallback) && <div className="product-share-status" role="status" aria-live="polite"><span>{shareStatus}</span>{shareFallback && <input value={shareFallback} readOnly onFocus={(event) => event.currentTarget.select()} aria-label={ar ? "رابط التقرير" : "Report link"} />}</div>}

    {layout === "table" && <section id="product-layout-table" role="tabpanel" aria-labelledby="product-layout-tab-table" className="product-layout-panel product-table-layout">
      <div className="product-compact-table-shell">
        <table className="product-compact-table" role="table">
          <thead role="rowgroup"><tr role="row">
            <th role="columnheader">{ar ? "منتجك" : "Your product"}</th>
            <th role="columnheader">{ar ? "سعرك" : "Your price"}</th>
            <th role="columnheader">{ar ? "أقرب منافس" : "Closest rival"}</th>
            <th role="columnheader">{ar ? "سعر المنافس" : "Rival price"}</th>
            <th role="columnheader">{ar ? "الفرق" : "Difference"}</th>
            <th role="columnheader">{ar ? "الخطوة التالية" : "Next move"}</th>
          </tr></thead>
          <tbody role="rowgroup">{rows.map((row, index) => {
            return <tr role="row" className="product-table-row" id={rowAnchor(row, index)} data-lane={row.lane} key={row.battle.key}>
              <td role="cell" className="product-table-product-cell product-table-your-product"><span className="product-table-mobile-label" aria-hidden="true">{ar ? "منتجك" : "Your product"}</span><ProductIdentity role="you" product={row.battle.primary} price={row.primaryDisplay} source={row.primarySource} ar={ar} compact showPrice={false} /></td>
              <td role="cell" className="product-table-price-cell product-table-your-price"><span className="product-table-mobile-label" aria-hidden="true">{ar ? "سعرك" : "Your price"}</span><ProductTablePrice value={row.primaryDisplay} ar={ar} /></td>
              <td role="cell" className="product-table-product-cell product-table-rival-product"><span className="product-table-mobile-label" aria-hidden="true">{ar ? "أقرب منافس" : "Closest rival"}</span><ProductIdentity role="rival" product={row.battle.rival} price={row.rivalDisplay} source={row.rivalSource} domain={row.domain} ar={ar} compact showPrice={false} /></td>
              <td role="cell" className="product-table-price-cell product-table-rival-price"><span className="product-table-mobile-label" aria-hidden="true">{ar ? "سعر المنافس" : "Rival price"}</span><ProductTablePrice value={row.rivalDisplay} ar={ar} /></td>
              <td role="cell" className="product-table-difference-cell"><span className="product-table-mobile-label" aria-hidden="true">{ar ? "الفرق" : "Difference"}</span><strong className={`product-signal ${row.lane}`}>{row.priceSignal}</strong>{row.priceDetail && <small dir="auto">{row.priceDetail}</small>}</td>
              <td role="cell" className="product-table-action-cell"><span className="product-table-mobile-label" aria-hidden="true">{ar ? "الخطوة التالية" : "Next move"}</span><strong className="product-next-move">{row.shortAction}</strong><ProductTableDetails row={row} observedAt={observedAt} ar={ar} /></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </section>}

    {layout === "matchups" && <section id="product-layout-matchups" role="tabpanel" aria-labelledby="product-layout-tab-matchups" className="product-layout-panel matchup-layout"><ul>{rows.map((row, index) => <li key={row.battle.key} id={rowAnchor(row, index)}><div className="matchup-products"><ProductIdentity role="you" product={row.battle.primary} price={row.primaryDisplay} source={row.primarySource} ar={ar} /><span aria-hidden="true">VS</span><ProductIdentity role="rival" product={row.battle.rival} price={row.rivalDisplay} source={row.rivalSource} domain={row.domain} ar={ar} /></div><div className="matchup-decision"><PricePosition comparisonValue={row.decision.priceComparison} primaryRaw={row.primaryDisplay} rivalRaw={row.rivalDisplay} priceVerdict={display(row.decision.priceVerdict)} locale={ar ? "ar" : "en"} primaryQuantity={row.battle.primary.quantity} rivalQuantity={row.battle.rival.quantity} showDetail={false} showValues={false} /><section><span>{ar ? "الخطوة التالية" : "NEXT MOVE"}</span><strong>{row.shortAction}</strong></section></div><MatchDetails row={row} observedAt={observedAt} ar={ar} /></li>)}</ul></section>}

    {layout === "opportunities" && <section id="product-layout-opportunities" role="tabpanel" aria-labelledby="product-layout-tab-opportunities" className="product-layout-panel opportunity-layout"><div className="opportunity-lanes">{lanes.map((lane) => { const items = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.lane === lane.id); return <section className={`opportunity-lane ${lane.id}`} aria-labelledby={`lane-${lane.id}`} key={lane.id}><header><div><h3 id={`lane-${lane.id}`}>{lane.title}</h3><p>{lane.description}</p></div><b>{items.length}</b></header><ul>{items.map(({ row, index }) => <li key={row.battle.key} id={rowAnchor(row, index)}><span>{row.domain}</span><div className="opportunity-pair"><strong dir="auto">{display(row.battle.primary.name)}</strong><i aria-hidden="true">→</i><strong dir="auto">{display(row.battle.rival.name)}</strong></div><div className="opportunity-prices"><b dir="auto">{row.primaryDisplay || (ar ? "سعرك غير مرصود" : "Your price not observed")}</b><b dir="auto">{row.rivalDisplay || (ar ? "سعر المنافس غير مرصود" : "Rival price not observed")}</b></div><p className="opportunity-signal">{row.priceSignal}</p><strong className="opportunity-action">{row.shortAction}</strong><MatchDetails row={row} observedAt={observedAt} ar={ar} /></li>)}</ul>{!items.length && <div className="opportunity-empty">{ar ? "لا توجد أزواج في هذه الفئة." : "No pairs in this group."}</div>}</section>; })}</div></section>}

    {catalogProducts.length > 0 && <details className="primary-catalog-panel"><summary><span>{ar ? "كتالوجك المحفوظ" : "Your saved catalog"}</span><strong>{catalogProducts.length}{primaryProducts?.truncated ? ` / ${primaryProducts.totalCount}` : ""}</strong></summary><div className="primary-catalog-grid">{catalogProducts.map((product) => <article key={display(product.id)}><ProductIdentity role="you" product={product} price={productPrice(product)} source={safeUrl(product.sourceUrl)} ar={ar} compact /></article>)}</div></details>}

    {!rows.length && <div className="truth-state limited"><strong>{ar ? "لا توجد مطابقة منتجات موثقة" : "No defensible product match was saved"}</strong><p>{ar ? "تم فحص الكتالوج، لكن لا ينبغي عرض زوج ضعيف على أنه مقارنة." : "Catalogs were assessed, but a weak pair should not be presented as a comparison."}</p></div>}
  </>;
}
