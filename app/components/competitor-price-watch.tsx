"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProductBattle } from "./product-design-lab";
import { jsonResponseErrorMessage, readJsonResponse } from "../lib/json-response";

type WatchCadence = "hourly" | "daily";
type ReportWatcher = { id: string; cadence: WatchCadence; state: string; links: Array<{ publicReportId: string; matchId: string }> };
type WatchUsage = { allocation: number; used: number; remaining: number };
type RivalSummary = { domain: string; count: number };
type MatchPagePayload = { ok: boolean; error?: string; errorCode?: string; page?: { authoritative: true; totalCount: number; domainCounts: Record<string, number>; items: ProductBattle[]; nextCursor: string | null } };

type CompetitorPriceWatchProps = {
  publicId: string;
  matchesEndpoint: string;
  rivals: RivalSummary[];
  ar: boolean;
};

function display(value: unknown, fallback = "") {
  return (typeof value === "string" ? value : "").trim() || fallback;
}

function rivalDomain(battle: ProductBattle) {
  return display(battle.match.domain || battle.rival.domain);
}

function safeUrl(value: unknown) {
  const url = display(value);
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : "";
}

function watcherIsRunning(watcher?: ReportWatcher) {
  return watcher?.state === "active" || watcher?.state === "baseline_pending";
}

export function CompetitorPriceWatch({ publicId, matchesEndpoint, rivals, ar }: CompetitorPriceWatchProps) {
  const [watchers, setWatchers] = useState<ReportWatcher[]>([]);
  const [watchUsage, setWatchUsage] = useState<WatchUsage | null>(null);
  const [watchAvailable, setWatchAvailable] = useState(false);
  const [watchCadences, setWatchCadences] = useState<Record<string, WatchCadence>>({});
  const [watchBusy, setWatchBusy] = useState("");
  const [watchMessage, setWatchMessage] = useState("");
  const [matches, setMatches] = useState<ProductBattle[]>([]);
  const [domainCounts, setDomainCounts] = useState<Record<string, number>>({});
  const [hasAuthoritativeCounts, setHasAuthoritativeCounts] = useState(false);
  const [matchTotal, setMatchTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [matchLoadState, setMatchLoadState] = useState<"loading" | "ready" | "more" | "fallback">("loading");
  const [matchLoadMessage, setMatchLoadMessage] = useState("");
  const activeReportId = useRef(publicId);

  const refreshWatchers = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/price-watch", { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" }, signal });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; watchers?: ReportWatcher[]; usage?: WatchUsage };
    if (signal?.aborted) return;
    if (!response.ok || !body.ok) { setWatchAvailable(false); return; }
    setWatchers(Array.isArray(body.watchers) ? body.watchers : []);
    setWatchUsage(body.usage || null);
    setWatchAvailable(true);
  }, []);

  const fetchMatchPage = useCallback(async (cursor?: string) => {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`${matchesEndpoint}?${query}`, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
    const body = await readJsonResponse<MatchPagePayload>(response, "Saved report matches");
    if (!response.ok || !body.ok || !body.page?.authoritative) throw new Error(body.error || "The complete saved matches are unavailable.");
    if (activeReportId.current !== publicId) throw new DOMException("Report changed", "AbortError");
    return body.page;
  }, [matchesEndpoint, publicId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void refreshWatchers(controller.signal).catch(() => { if (!controller.signal.aborted) setWatchAvailable(false); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [publicId, refreshWatchers]);

  useEffect(() => {
    activeReportId.current = publicId;
    let current = true;
    fetchMatchPage().then((page) => {
      if (!current) return;
      setMatches(page.items);
      setDomainCounts(page.domainCounts || {});
      setHasAuthoritativeCounts(true);
      setMatchTotal(page.totalCount);
      setNextCursor(page.nextCursor);
      setMatchLoadState("ready");
    }).catch((cause) => {
      if (!current || cause instanceof DOMException && cause.name === "AbortError") return;
      setMatchLoadState("fallback");
      setMatchLoadMessage(jsonResponseErrorMessage(cause, "Individual saved matches could not be loaded."));
    });
    return () => { current = false; if (activeReportId.current === publicId) activeReportId.current = ""; };
  }, [fetchMatchPage, publicId]);

  const rivalRows = useMemo(() => {
    const merged = new Map<string, number>();
    for (const rival of rivals) {
      if (!rival.domain) continue;
      const count = hasAuthoritativeCounts ? Number(domainCounts[rival.domain] ?? 0) : rival.count;
      merged.set(rival.domain, Math.max(0, count));
    }
    for (const [domain, count] of Object.entries(domainCounts)) if (domain) merged.set(domain, Math.max(0, Number(count) || 0));
    for (const match of matches) {
      const domain = rivalDomain(match);
      if (domain && !merged.has(domain)) merged.set(domain, Math.max(0, Number(domainCounts[domain]) || 0));
    }
    return [...merged.entries()].map(([domain, count]) => ({ domain, count }));
  }, [domainCounts, hasAuthoritativeCounts, matches, rivals]);

  const watcherForMatch = (matchId: string) => watchers.find((watcher) => watcher.links.some((link) => link.publicReportId === publicId && link.matchId === matchId));
  const selectedCadence = (matchId: string, watcher?: ReportWatcher) => watchCadences[matchId] || watcher?.cadence || "daily";

  async function watcherRequest(path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
    const response = await fetch(path, { method, credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(result.error || "The price watcher could not be updated.");
  }

  async function toggleMatchWatch(matchId: string, enable: boolean) {
    if (!/^[a-f0-9]{64}$/.test(matchId)) return;
    const watcher = watcherForMatch(matchId);
    const cadence = selectedCadence(matchId, watcher);
    setWatchBusy(matchId);
    setWatchMessage("");
    try {
      if (enable && !watcher) await watcherRequest("/api/price-watch", "POST", { publicReportId: publicId, matchId, cadence });
      else if (enable && watcher) await watcherRequest(`/api/price-watch/${watcher.id}`, "PATCH", { action: "resume", cadence });
      else if (watcher) await watcherRequest(`/api/price-watch/${watcher.id}`, "PATCH", { action: "disable" });
      await refreshWatchers();
    } catch (cause) { setWatchMessage(cause instanceof Error ? cause.message : "The watcher could not be updated."); }
    finally { setWatchBusy(""); }
  }

  async function changeMatchCadence(matchId: string, cadence: WatchCadence) {
    setWatchCadences((current) => ({ ...current, [matchId]: cadence }));
    const watcher = watcherForMatch(matchId);
    if (!watcher) return;
    setWatchBusy(matchId);
    setWatchMessage("");
    try { await watcherRequest(`/api/price-watch/${watcher.id}`, "PATCH", { cadence }); await refreshWatchers(); }
    catch (cause) { setWatchMessage(cause instanceof Error ? cause.message : "The frequency could not be updated."); }
    finally { setWatchBusy(""); }
  }

  async function watchRivalSnapshot(domain: string, count: number) {
    const key = `rival:${domain}`;
    const cadence = watchCadences[key] || "daily";
    const checksPerDay = count * (cadence === "hourly" ? 24 : 1);
    const afterBaseline = Math.max(0, (watchUsage?.remaining || 0) - count);
    const estimatedDays = checksPerDay > 0 ? Math.floor(afterBaseline / checksPerDay) : 0;
    const confirmation = ar
      ? `مراقبة لقطة ثابتة تصل إلى ${count} رابطاً من ${domain}؟\n\nقد تستهلك ${count} رصيداً لإنشاء خطوط الأساس، ثم حوالي ${checksPerDay} رصيداً يومياً. الرصيد المتبقي بعد ذلك يكفي تقريباً ${estimatedDays} يوماً بالمعدل الحالي.`
      : `Watch a fixed snapshot of up to ${count} saved URLs from ${domain}?\n\nThis may use ${count} credits for baselines, then about ${checksPerDay} credits per day. The remaining balance would last roughly ${estimatedDays} days at that pace.`;
    if (!window.confirm(confirmation)) return;
    setWatchBusy(key);
    setWatchMessage("");
    try {
      await watcherRequest("/api/price-watch", "POST", { publicReportId: publicId, rivalDomain: domain, cadence });
      await refreshWatchers();
      setWatchMessage(ar ? `تم حفظ لقطة مراقبة ثابتة لـ ${domain}.` : `Saved a fixed watch snapshot for ${domain}.`);
    } catch (cause) { setWatchMessage(cause instanceof Error ? cause.message : "The rival snapshot could not be watched."); }
    finally { setWatchBusy(""); }
  }

  async function loadMoreMatches() {
    if (!nextCursor || matchLoadState === "more") return;
    setMatchLoadState("more");
    setMatchLoadMessage("");
    try {
      const page = await fetchMatchPage(nextCursor);
      setMatches((current) => [...current, ...page.items]);
      setDomainCounts(page.domainCounts || {});
      setHasAuthoritativeCounts(true);
      setMatchTotal(page.totalCount);
      setNextCursor(page.nextCursor);
      setMatchLoadState("ready");
    } catch (cause) {
      setMatchLoadState("ready");
      setMatchLoadMessage(jsonResponseErrorMessage(cause, "More saved matches could not be loaded."));
    }
  }

  if (!watchAvailable) return null;

  return <section className="report-price-watch-panel competitor-price-watch-panel" aria-label={ar ? "مراقبة أسعار المنافسين" : "Rival price watch"}>
    <header><div><span>{ar ? "مراقبة اختيارية" : "OPT-IN PRICE WATCH"}</span><h3>{ar ? "راقب المنافس أو اختر روابط منتجات محددة" : "Watch a rival or choose specific product URLs"}</h3><p>{ar ? "كل فحص لرابط منتج محفوظ يستهلك رصيداً واحداً. لا بحث ولا ذكاء اصطناعي." : "Each check of a saved product URL uses one credit. Monitoring never runs search or AI."}</p></div><Link href="/price-watch">{ar ? "إدارة المراقبة" : "Manage watchers"}</Link></header>
    {watchUsage && <div className="report-watch-balance"><strong>{watchUsage.remaining.toLocaleString()}</strong><span>{ar ? "رصيد متبقٍ" : "credits remaining"}</span></div>}
    <div className="competitor-watch-rivals">{rivalRows.map(({ domain, count }) => {
      const key = `rival:${domain}`;
      const cadence = watchCadences[key] || "daily";
      const checksPerDay = count * (cadence === "hourly" ? 24 : 1);
      const domainMatches = matches.filter((match) => rivalDomain(match) === domain);
      return <article className="competitor-watch-card" key={domain}>
        <div className="competitor-watch-rival-row">
          <div><strong>{domain}</strong><small>{count} {ar ? "روابط مؤهلة في اللقطة الثابتة" : "eligible URLs in the fixed snapshot"} · {checksPerDay.toLocaleString()} {ar ? "فحصاً يومياً" : "checks/day"}</small></div>
          <label><span>{ar ? "التكرار" : "Frequency"}</span><select value={cadence} disabled={watchBusy === key} onChange={(event) => setWatchCadences((current) => ({ ...current, [key]: event.target.value as WatchCadence }))}><option value="daily">{ar ? "يومي" : "Daily"}</option><option value="hourly">{ar ? "كل ساعة" : "Hourly"}</option></select></label>
          <button type="button" disabled={count < 1 || watchBusy === key} onClick={() => void watchRivalSnapshot(domain, count)}>{watchBusy === key ? (ar ? "جارٍ الحفظ…" : "Saving…") : (ar ? "راقب الكل" : "Watch all")}</button>
        </div>
        <details className="competitor-watch-products">
          <summary>{ar ? `اختر منتجات محددة (${domainMatches.length}${domainMatches.length < count ? ` من ${count}` : ""})` : `Choose specific products (${domainMatches.length}${domainMatches.length < count ? ` of ${count}` : ""})`}</summary>
          {domainMatches.length > 0 ? <ul>{domainMatches.map((match) => {
            const matchId = match.key;
            const watcher = watcherForMatch(matchId);
            const running = watcherIsRunning(watcher);
            const itemCadence = selectedCadence(matchId, watcher);
            const rivalSource = safeUrl(match.rival.sourceUrl);
            const primaryName = display(match.primary.name, ar ? "منتجك" : "Your product");
            const rivalName = display(match.rival.name, ar ? "منتج المنافس" : "Rival product");
            const toggleLabel = ar ? `مراقبة سعر ${rivalName} المطابق لـ ${primaryName}` : `Watch the price of ${rivalName}, matched to ${primaryName}`;
            const cadenceLabel = ar ? `تكرار مراقبة سعر ${rivalName}` : `Price-watch frequency for ${rivalName}`;
            return <li key={matchId}>
              <div><span dir="auto">{primaryName}</span><strong dir="auto">{rivalName}</strong>{rivalSource && <a href={rivalSource} target="_blank" rel="noreferrer">{ar ? "افتح السعر العام ↗" : "Open public price ↗"}</a>}</div>
              <div className="competitor-watch-item-controls"><label className="watch-switch"><input type="checkbox" aria-label={toggleLabel} checked={running} disabled={watchBusy === matchId} onChange={(event) => void toggleMatchWatch(matchId, event.target.checked)} /><span aria-hidden="true" /><b>{running ? (ar ? "مفعّل" : "On") : (ar ? "متوقف" : "Off")}</b></label><select aria-label={cadenceLabel} value={itemCadence} disabled={watchBusy === matchId} onChange={(event) => void changeMatchCadence(matchId, event.target.value as WatchCadence)}><option value="daily">{ar ? "يومي" : "Daily"}</option><option value="hourly">{ar ? "كل ساعة" : "Hourly"}</option></select>{watcher && !running && <small>{watcher.state.replace(/_/g, " ")}</small>}</div>
            </li>;
          })}</ul> : <p>{matchLoadState === "loading"
            ? (ar ? "جارٍ تحميل روابط المنتجات المحفوظة…" : "Loading saved product URLs…")
            : matchLoadState === "fallback"
              ? (ar ? "تعذر تحميل عناصر التحكم للروابط الفردية مؤقتاً. لا يزال خيار مراقبة الكل متاحاً." : "Individual URL controls are temporarily unavailable. Watch all remains available.")
              : hasAuthoritativeCounts && count === 0
                ? (ar ? "لا توجد روابط منتجات مؤهلة محفوظة لهذا المنافس." : "No eligible saved product URLs are available for this rival.")
                : nextCursor
                  ? (ar ? "حمّل المزيد من الروابط أدناه لاختيار منتجات من هذا المنافس." : "Load more URLs below to choose products from this rival.")
                  : (ar ? "لا توجد روابط منتجات مؤهلة محفوظة لهذا المنافس." : "No eligible saved product URLs are available for this rival.")}</p>}
        </details>
      </article>;
    })}</div>
    {nextCursor && <div className="competitor-watch-load-more"><button type="button" onClick={() => void loadMoreMatches()} disabled={matchLoadState === "more"}>{matchLoadState === "more" ? (ar ? "جارٍ التحميل…" : "Loading…") : (ar ? `تحميل روابط أكثر (${Math.max(0, matchTotal - matches.length)} متبقية)` : `Load more URLs (${Math.max(0, matchTotal - matches.length)} remaining)`)}</button></div>}
    {matchLoadMessage && <p className="report-watch-message" role="status">{matchLoadMessage}</p>}
    {watchMessage && <p className="report-watch-message" role="status">{watchMessage}</p>}
  </section>;
}
