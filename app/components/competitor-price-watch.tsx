"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { readJsonResponse } from "../lib/json-response";

type WatchCadence = "hourly" | "daily";
type WatchUsage = { allocation: number; used: number; remaining: number };
type RivalSummary = { domain: string; count: number };
type MatchPagePayload = { ok: boolean; error?: string; page?: { authoritative: true; domainCounts: Record<string, number> } };

type CompetitorPriceWatchProps = {
  publicId: string;
  matchesEndpoint: string;
  rivals: RivalSummary[];
  ar: boolean;
};

export function CompetitorPriceWatch({ publicId, matchesEndpoint, rivals, ar }: CompetitorPriceWatchProps) {
  const [watchUsage, setWatchUsage] = useState<WatchUsage | null>(null);
  const [watchAvailable, setWatchAvailable] = useState(false);
  const [watchCadences, setWatchCadences] = useState<Record<string, WatchCadence>>({});
  const [watchBusy, setWatchBusy] = useState("");
  const [watchMessage, setWatchMessage] = useState("");
  const [domainCounts, setDomainCounts] = useState<Record<string, number>>({});
  const [hasAuthoritativeCounts, setHasAuthoritativeCounts] = useState(false);

  const refreshWatchers = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/price-watch", { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" }, signal });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; usage?: WatchUsage };
    if (signal?.aborted) return;
    if (!response.ok || !body.ok) { setWatchAvailable(false); return; }
    setWatchUsage(body.usage || null);
    setWatchAvailable(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void refreshWatchers(controller.signal).catch(() => { if (!controller.signal.aborted) setWatchAvailable(false); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [publicId, refreshWatchers]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: "1" });
    void (async () => {
      try {
        const response = await fetch(`${matchesEndpoint}?${query}`, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" }, signal: controller.signal });
        const body = await readJsonResponse<MatchPagePayload>(response, "Saved report match counts");
        if (!response.ok || !body.ok || !body.page?.authoritative) return;
        setDomainCounts(body.page.domainCounts || {});
        setHasAuthoritativeCounts(true);
      } catch {
        // The rival cards still have their compact saved counts as a safe fallback.
      }
    })();
    return () => controller.abort();
  }, [matchesEndpoint, publicId]);

  const rivalRows = useMemo(() => {
    const merged = new Map<string, number>();
    for (const rival of rivals) {
      if (!rival.domain) continue;
      const count = hasAuthoritativeCounts ? Number(domainCounts[rival.domain] ?? 0) : rival.count;
      merged.set(rival.domain, Math.max(0, count));
    }
    for (const [domain, count] of Object.entries(domainCounts)) {
      if (domain) merged.set(domain, Math.max(0, Number(count) || 0));
    }
    return [...merged.entries()].map(([domain, count]) => ({ domain, count }));
  }, [domainCounts, hasAuthoritativeCounts, rivals]);

  async function watcherRequest(body: Record<string, unknown>) {
    const response = await fetch("/api/price-watch", { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(result.error || "The price watcher could not be updated.");
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
      await watcherRequest({ publicReportId: publicId, rivalDomain: domain, cadence });
      await refreshWatchers();
      setWatchMessage(ar ? `تم حفظ لقطة مراقبة ثابتة لـ ${domain}.` : `Saved a fixed watch snapshot for ${domain}.`);
    } catch (cause) {
      setWatchMessage(cause instanceof Error ? cause.message : "The rival snapshot could not be watched.");
    } finally {
      setWatchBusy("");
    }
  }

  if (!watchAvailable) return null;

  return <section className="report-price-watch-panel competitor-price-watch-panel" aria-label={ar ? "مراقبة أسعار المنافسين" : "Rival price watch"}>
    <header><div><span>{ar ? "مراقبة اختيارية" : "OPT-IN PRICE WATCH"}</span><h3>{ar ? "راقب كل الروابط المحفوظة لمنافس" : "Watch every saved URL for a rival"}</h3><p>{ar ? "ابدأ مراقبة منافس كامل من هنا. لمراقبة عنصر واحد فقط، استخدم المفتاح الموجود بجانب المقارنة في صفحة المنتجات." : "Start a rival-wide watch here. To monitor one item only, use its switch beside the comparison in Products."}</p></div><Link href="/price-watch">{ar ? "إدارة المراقبة" : "Manage watchers"}</Link></header>
    {watchUsage && <div className="report-watch-balance"><strong>{watchUsage.remaining.toLocaleString()}</strong><span>{ar ? "رصيد متبقٍ" : "credits remaining"}</span></div>}
    <div className="competitor-watch-rivals">{rivalRows.map(({ domain, count }) => {
      const key = `rival:${domain}`;
      const cadence = watchCadences[key] || "daily";
      const checksPerDay = count * (cadence === "hourly" ? 24 : 1);
      return <article className="competitor-watch-card" key={domain}>
        <div className="competitor-watch-rival-row">
          <div><strong>{domain}</strong><small>{count} {ar ? "روابط مؤهلة في اللقطة الثابتة" : "eligible URLs in the fixed snapshot"} · {checksPerDay.toLocaleString()} {ar ? "فحصاً يومياً" : "checks/day"}</small></div>
          <label><span>{ar ? "التكرار" : "Frequency"}</span><select value={cadence} disabled={watchBusy === key} onChange={(event) => setWatchCadences((current) => ({ ...current, [key]: event.target.value as WatchCadence }))}><option value="daily">{ar ? "يومي" : "Daily"}</option><option value="hourly">{ar ? "كل ساعة" : "Hourly"}</option></select></label>
          <button type="button" disabled={count < 1 || watchBusy === key} onClick={() => void watchRivalSnapshot(domain, count)}>{watchBusy === key ? (ar ? "جارٍ الحفظ…" : "Saving…") : (ar ? "راقب الكل" : "Watch all")}</button>
        </div>
      </article>;
    })}</div>
    {watchMessage && <p className="report-watch-message" role="status">{watchMessage}</p>}
  </section>;
}
