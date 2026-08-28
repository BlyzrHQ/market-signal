"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { accountAuthClient } from "../lib/account-auth-client.ts";
import { newestAccountReportPath, safeAccountReturnPath } from "../lib/account-report-redirect.ts";

const PLANS = [
  { id: "starter", name: "Starter", monthlyPriceUsd: 8, reportsPerMonth: 5, productLimit: 20 },
  { id: "solo", name: "Solo", monthlyPriceUsd: 29, reportsPerMonth: 10, productLimit: 50 },
  { id: "growth", name: "Growth", monthlyPriceUsd: 79, reportsPerMonth: 40, productLimit: 500 },
  { id: "agency", name: "Agency", monthlyPriceUsd: 199, reportsPerMonth: 120, productLimit: 1_000 },
];

type Status = {
  authenticated: boolean;
  user?: { name: string; email: string };
  subscription?: { plan: { id: string; name: string; reportsPerMonth: number; productLimit: number; monitoringCredits: number } | null; status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: string } | null;
  usage?: { used: number; limit: number };
  monitoringUsage?: { used: number; allocation: number; remaining: number };
};

type ConnectedApp = {
  consentId: string;
  client: { clientId: string; host: string; name: string; verified: false };
  scopes: string[];
  connectedAt: string;
  status: "active" | "reauthorization_required";
};

async function jsonRequest(url: string, body?: unknown) {
  const response = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.message || result.error || "The request could not be completed."));
  return result;
}

export default function AccountPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-up");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>([]);

  async function load() {
    const response = await fetch("/api/billing/subscription", { cache: "no-store" });
    const next = response.ok ? await response.json() as Status : { authenticated: false };
    setStatus(next);
    if (next.authenticated) {
      const apps = await fetch("/api/account/connected-apps", { cache: "no-store" });
      if (apps.ok) setConnectedApps(((await apps.json()) as { apps?: ConnectedApp[] }).apps || []);
    } else {
      setConnectedApps([]);
    }
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      const response = await fetch("/api/billing/subscription", { cache: "no-store" });
      const next = response.ok ? await response.json() as Status : { authenticated: false };
      if (!active) return;
      setStatus(next);
      if (next.authenticated) {
        const apps = await fetch("/api/account/connected-apps", { cache: "no-store" });
        if (active && apps.ok) setConnectedApps(((await apps.json()) as { apps?: ConnectedApp[] }).apps || []);
      }
    })();
    return () => { active = false; };
  }, []);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const credentials = {
        email: String(data.get("email") || ""),
        password: String(data.get("password") || ""),
      };
      const result = mode === "sign-up"
        ? await accountAuthClient.signUp.email({ ...credentials, name: String(data.get("name") || "") })
        : await accountAuthClient.signIn.email(credentials);
      if (result.error) throw new Error(result.error.message || "Authentication failed.");
      const oauthResult = result.data as unknown as { redirect_uri?: string; url?: string } | null;
      const oauthRedirect = oauthResult?.redirect_uri || oauthResult?.url;
      if (oauthRedirect) {
        window.location.assign(oauthRedirect);
        return;
      }
      const requestedPath = safeAccountReturnPath(new URLSearchParams(window.location.search).get("next"));
      if (requestedPath) {
        window.location.assign(requestedPath);
        return;
      }
      const reportsResponse = await fetch("/api/account/reports", { cache: "no-store", credentials: "same-origin" });
      if (reportsResponse.ok) {
        const reportsPath = newestAccountReportPath(await reportsResponse.json().catch(() => null));
        if (reportsPath) {
          window.location.assign(reportsPath);
          return;
        }
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed.");
    } finally { setBusy(false); }
  }

  async function billing(path: "checkout" | "portal", plan?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await jsonRequest(`/api/billing/${path}`, plan ? { plan } : {});
      window.location.assign(String(result.url));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Billing is unavailable.");
      setBusy(false);
    }
  }

  if (!status) return <main className="account-page"><p>Loading your account…</p></main>;
  return <main className="account-page">
    <header><Link className="brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></Link><Link href="/pricing">Pricing</Link></header>
    {!status.authenticated ? <section className="auth-card">
      <span>YOUR MARKET SIGNAL ACCOUNT</span>
      <h1>{mode === "sign-up" ? "Create your workspace." : "Welcome back."}</h1>
      <p>Your reports, plan limits, and billing stay attached to one private workspace.</p>
      <form onSubmit={authenticate}>
        {mode === "sign-up" && <label>Name<input name="name" required autoComplete="name" /></label>}
        <label>Email<input name="email" required type="email" autoComplete="email" /></label>
        <label>Password<input name="password" required type="password" minLength={8} autoComplete={mode === "sign-up" ? "new-password" : "current-password"} /></label>
        <button disabled={busy}>{busy ? "Please wait…" : mode === "sign-up" ? "Create account" : "Sign in"}</button>
      </form>
      {error && <p className="account-error" role="alert">{error}</p>}
      <button className="account-text-button" onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}>{mode === "sign-up" ? "Already have an account? Sign in" : "New here? Create an account"}</button>
    </section> : <section className="account-dashboard">
      <div><span>ACCOUNT</span><h1>{status.user?.name || status.user?.email}</h1><p>{status.user?.email}</p></div>
      <article>
        <span>CURRENT PLAN</span>
        <h2>{status.subscription?.plan?.name || "No active plan"}</h2>
        {status.subscription?.plan ? <><p><b>{status.usage?.used || 0}</b> of <b>{status.usage?.limit || 0}</b> reports used this billing period</p><p>{status.subscription.plan.productLimit.toLocaleString()} products assessed per report · {status.subscription.status}</p><p><b>{status.monitoringUsage?.remaining ?? status.subscription.plan.monitoringCredits}</b> of <b>{status.monitoringUsage?.allocation || status.subscription.plan.monitoringCredits}</b> price-check credits remaining</p><div className="account-plan-actions"><Link href="/price-watch">Manage price watchers</Link><button disabled={busy} onClick={() => billing("portal")}>Manage billing</button></div></> : <p>Choose a plan to start creating hosted reports.</p>}
      </article>
      <article className="connected-apps-card">
        <span>CONNECTED APPS</span>
        <h2>AI access</h2>
        <p>Claude, Codex, and other MCP clients appear here after you approve access. Client names are self-asserted; verify the displayed client ID host before connecting.</p>
        {connectedApps.length === 0 ? <p>No apps are connected.</p> : <div className="connected-app-list">{connectedApps.map((app) => <div key={app.consentId}>
          <div><strong>{app.client.name}</strong><small>{app.client.host} · Unverified identity</small><small>{app.status === "active" ? "Active" : "Reauthorization required"}</small></div>
          <button disabled={busy} onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const response = await fetch(`/api/account/connected-apps/${encodeURIComponent(app.consentId)}`, { method: "DELETE" });
              const body = await response.json().catch(() => ({})) as { error?: string };
              if (!response.ok) throw new Error(body.error || "The app could not be revoked.");
              await load();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "The app could not be revoked.");
            } finally {
              setBusy(false);
            }
          }}>Revoke</button>
        </div>)}</div>}
      </article>
      {!status.subscription?.plan && <div className="account-plan-grid">{PLANS.map((plan) => <button disabled={busy} key={plan.id} onClick={() => billing("checkout", plan.id)}><span>{plan.name}</span><strong>${plan.monthlyPriceUsd}/mo</strong><small>{plan.reportsPerMonth} reports · {plan.productLimit.toLocaleString()} products/report</small></button>)}</div>}
      {error && <p className="account-error" role="alert">{error}</p>}
      <button className="account-text-button" onClick={async () => { await jsonRequest("/api/auth/sign-out", {}); await load(); }}>Sign out</button>
    </section>}
  </main>;
}
