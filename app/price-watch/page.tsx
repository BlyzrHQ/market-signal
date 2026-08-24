"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Usage = { planTier: string; periodStart: string; periodEnd: string; allocation: number; used: number; remaining: number; projectedDaily: number; projectedMonthly: number };
type Snapshot = { currency: string; amountMicros: number; raw: string; listAmountMicros: number | null; listRaw: string };
type Watcher = {
  id: string; canonicalUrl: string; rivalDomain: string; productName: string; cadence: "hourly" | "daily";
  state: string; pauseReason: string; baseline: Snapshot | null; failureStreak: number; nextCheckAt: string; lastCheckAt: string;
};
type Notification = { id: string; watcherId: string; type: string; title: string; body: string; createdAt: string; read: boolean };
type History = { id: string; kind: string; currency: string; amountMicros: number; raw: string; listAmountMicros: number | null; listRaw: string; observedAt: string };

class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "ApiError"; this.status = status; }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error || "The request could not be completed.", response.status);
  return body;
}

function price(snapshot: Snapshot | null) {
  if (!snapshot) return "Baseline pending";
  return `${snapshot.currency} ${(snapshot.amountMicros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

function stateLabel(state: string) {
  return ({ active: "Active", baseline_pending: "Baseline pending", disabled: "Off", paused_credits: "Credits paused", paused_subscription: "Subscription paused", paused_failure: "Needs attention" } as Record<string, string>)[state] || state;
}

export default function PriceWatchPage() {
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [history, setHistory] = useState<Record<string, History[]>>({});
  const [expanded, setExpanded] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [watch, alerts] = await Promise.all([
        api<{ watchers: Watcher[]; usage: Usage }>("/api/price-watch", { signal }),
        api<{ items: Notification[]; unread: number }>("/api/price-watch/notifications", { signal }),
      ]);
      if (signal?.aborted) return;
      setWatchers(watch.watchers); setUsage(watch.usage); setNotifications(alerts.items); setUnread(alerts.unread); setAuthenticated(true);
    } catch (cause) {
      if (signal?.aborted) return;
      setAuthenticated(cause instanceof ApiError ? cause.status !== 401 : true);
      setError(cause instanceof Error ? cause.message : "Price monitoring is unavailable.");
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function mutate(watcher: Watcher, body: Record<string, unknown>) {
    setBusy(watcher.id); setError("");
    try {
      await api(`/api/price-watch/${watcher.id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The watcher could not be updated."); }
    finally { setBusy(""); }
  }

  async function remove(watcher: Watcher) {
    if (!window.confirm(`Permanently delete the watcher and history for ${watcher.productName}?`)) return;
    setBusy(watcher.id); setError("");
    try { await api(`/api/price-watch/${watcher.id}`, { method: "DELETE" }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The watcher could not be deleted."); }
    finally { setBusy(""); }
  }

  async function toggleHistory(watcher: Watcher) {
    if (expanded === watcher.id) { setExpanded(""); return; }
    setExpanded(watcher.id);
    if (history[watcher.id]) return;
    try {
      const result = await api<{ history: History[] }>(`/api/price-watch/${watcher.id}?limit=100`);
      setHistory((current) => ({ ...current, [watcher.id]: result.history }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "History could not be loaded."); }
  }

  async function markAlertsRead() {
    const ids = notifications.filter((item) => !item.read).map((item) => item.id);
    if (!ids.length) return;
    try {
      await api("/api/price-watch/notifications", { method: "POST", body: JSON.stringify({ notificationIds: ids }) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Alerts could not be updated."); }
  }

  return <main className="price-watch-page">
    <header className="price-watch-nav"><Link className="brand" href="/">Market Signal</Link><nav><Link href="/account">Account</Link><Link aria-current="page" href="/price-watch">Price watch{unread > 0 && <b>{unread}</b>}</Link></nav></header>
    <section className="price-watch-hero"><div><span>EXACT-URL MONITORING</span><h1>Watch the prices that matter.</h1><p>Each credit checks one saved rival product URL. No search, AI, or automatic product expansion runs in the background.</p></div><Link href="/">Open a report</Link></section>
    {!authenticated ? <section className="price-watch-empty"><h2>Sign in to your workspace</h2><p>Price watchers and alerts are private to the workspace that owns the report.</p>{error && <p className="price-watch-error" role="alert">{error}</p>}<Link href="/account?next=%2Fprice-watch">Sign in</Link></section> : <>
      {usage && <section className="price-watch-balance" aria-label="Monitoring credit balance"><article><span>Remaining</span><strong>{usage.remaining.toLocaleString()}</strong><small>of {usage.allocation.toLocaleString()} this billing period</small></article><article><span>Used</span><strong>{usage.used.toLocaleString()}</strong><small>resets {usage.periodEnd ? new Date(usage.periodEnd).toLocaleDateString() : "with billing"}</small></article><article><span>Current pace</span><strong>{usage.projectedDaily.toLocaleString()}<em>/day</em></strong><small>about {usage.projectedMonthly.toLocaleString()} credits per 30 days</small></article></section>}
      {error && <p className="price-watch-error" role="alert">{error}</p>}
      <div className="price-watch-grid">
        <section className="price-watch-list"><header><div><span>WATCHERS</span><h2>{watchers.length} exact targets</h2></div></header>
          {watchers.map((watcher) => <article className="price-watch-card" key={watcher.id}>
            <header><div><span>{watcher.rivalDomain}</span><h3>{watcher.productName}</h3></div><b className={`watch-state state-${watcher.state}`}>{stateLabel(watcher.state)}</b></header>
            <div className="price-watch-current"><strong>{price(watcher.baseline)}</strong>{watcher.baseline?.listAmountMicros && <small>Regular/list {watcher.baseline.currency} {(watcher.baseline.listAmountMicros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })}</small>}<small>{watcher.lastCheckAt ? `Checked ${new Date(watcher.lastCheckAt).toLocaleString()}` : "Waiting for the first check"}{watcher.nextCheckAt ? ` · Next ${new Date(watcher.nextCheckAt).toLocaleString()}` : ""}</small></div>
            <div className="price-watch-controls"><label>Frequency<select value={watcher.cadence} disabled={busy === watcher.id} onChange={(event) => void mutate(watcher, { cadence: event.target.value })}><option value="hourly">Hourly · 24 credits/day</option><option value="daily">Daily · 1 credit/day</option></select></label>{watcher.state === "active" || watcher.state === "baseline_pending" ? <button disabled={busy === watcher.id} onClick={() => void mutate(watcher, { action: "disable" })}>Turn off</button> : <button disabled={busy === watcher.id} onClick={() => void mutate(watcher, { action: "resume" })}>Resume</button>}<button className="danger" disabled={busy === watcher.id} onClick={() => void remove(watcher)}>Delete</button></div>
            {watcher.pauseReason && <p className="price-watch-reason">{watcher.pauseReason.replace(/[-:]/g, " ")}{watcher.failureStreak ? ` · ${watcher.failureStreak} failures` : ""}</p>}
            <footer><a href={watcher.canonicalUrl} target="_blank" rel="noreferrer">Open exact product ↗</a><button onClick={() => void toggleHistory(watcher)}>{expanded === watcher.id ? "Hide history" : "Price history"}</button></footer>
            {expanded === watcher.id && <ol className="price-watch-history">{(history[watcher.id] || []).map((entry) => <li key={entry.id}><i /><div><strong>{entry.currency} {(entry.amountMicros / 1_000_000).toLocaleString()}</strong><span>{entry.kind.replace(/-/g, " ")}{entry.listAmountMicros ? ` · list ${entry.currency} ${(entry.listAmountMicros / 1_000_000).toLocaleString()}` : ""}</span></div><time>{new Date(entry.observedAt).toLocaleString()}</time></li>)}{history[watcher.id]?.length === 0 && <li>No price changes recorded yet.</li>}</ol>}
          </article>)}
          {!watchers.length && <div className="price-watch-empty"><h3>No watched prices yet</h3><p>Open an owned report and turn on a saved comparison, or watch a fixed snapshot for one rival.</p></div>}
        </section>
        <aside className="price-watch-alerts"><header><div><span>IN-APP ALERTS</span><h2>Workspace activity</h2></div>{unread > 0 && <button onClick={() => void markAlertsRead()}>Mark read</button>}</header>{notifications.map((item) => <article className={item.read ? "read" : "unread"} key={item.id}><i /><div><strong>{item.title}</strong><p>{item.body}</p><time>{new Date(item.createdAt).toLocaleString()}</time></div></article>)}{!notifications.length && <p>No price alerts yet.</p>}</aside>
      </div>
    </>}
  </main>;
}
