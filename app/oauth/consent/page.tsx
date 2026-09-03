"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { accountAuthClient } from "../../lib/account-auth-client.ts";
import {
  MCP_AUTHORIZATION_SCOPES,
  MCP_SCOPE_DETAILS,
  mcpClientIdentity,
  type McpResourceScope,
} from "../../lib/mcp-oauth-shared.ts";

type PublicClient = {
  client_id?: string;
  client_name?: string;
  client_uri?: string;
};

export default function OAuthConsentPage() {
  const [client, setClient] = useState<PublicClient | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const query = useMemo(() => typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search), []);
  const clientId = query.get("client_id") || "";
  const requestedScopes = [...new Set((query.get("scope") || "").split(/\s+/).filter(Boolean))];
  const unsupportedScopes = requestedScopes.filter((scope) => !MCP_AUTHORIZATION_SCOPES.includes(scope as never));
  const identity = mcpClientIdentity(clientId, client?.client_name);
  const visibleError = !clientId ? "This authorization request is missing its client identity." : error;

  useEffect(() => {
    let active = true;
    if (!clientId) return;
    void fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("The requesting client could not be verified against its metadata document.");
        const value = await response.json() as PublicClient;
        if (active) setClient(value);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "The requesting client is unavailable.");
      });
    return () => { active = false; };
  }, [clientId]);

  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await accountAuthClient.oauth2.consent({ accept });
      if (result.error) throw new Error(result.error.message || "Authorization could not be completed.");
      const response = result.data as { redirect_uri?: string; url?: string } | null;
      const redirect = response?.redirect_uri || response?.url;
      if (!redirect) throw new Error("The authorization server did not return a safe continuation URL.");
      window.location.assign(redirect);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authorization could not be completed.");
      setBusy(false);
    }
  }

  return <main className="oauth-consent-page">
    <header><Link className="brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></Link></header>
    <section className="oauth-consent-card">
      <span>{identity.verified ? "CONNECT MARKET SIGNAL CLI" : "CONNECT AN AI CLIENT"}</span>
      <h1>Allow access to your workspace?</h1>
      <div className="oauth-client-identity">
        <strong>{identity.name}</strong>
        <code>{identity.clientId || "Missing client ID"}</code>
        <small>Host: {identity.host || "unknown"} · {identity.verified ? "Verified Market Signal client" : "Self-asserted, unverified identity"}</small>
      </div>
      <p>{identity.verified ? "This first-party CLI will use only the permissions listed below." : "Only approve this request if the client ID host is the one you intended to connect."}</p>
      <div className="oauth-scope-list">
        {requestedScopes.filter((scope): scope is McpResourceScope => scope in MCP_SCOPE_DETAILS).map((scope) => <article key={scope}>
          <strong>{MCP_SCOPE_DETAILS[scope].title}</strong>
          <p>{MCP_SCOPE_DETAILS[scope].description}</p>
        </article>)}
        {requestedScopes.includes("offline_access") && <article><strong>Stay connected</strong><p>Use a rotating refresh token so the client can reconnect without asking for your password.</p></article>}
      </div>
      {unsupportedScopes.length > 0 && <p className="account-error" role="alert">This request includes unsupported access: {unsupportedScopes.join(", ")}.</p>}
      {visibleError && <p className="account-error" role="alert">{visibleError}</p>}
      <div className="oauth-consent-actions">
        <button className="oauth-deny" disabled={busy} onClick={() => decide(false)}>Deny</button>
        <button disabled={busy || !client || unsupportedScopes.length > 0} onClick={() => decide(true)}>{busy ? "Please wait…" : "Allow access"}</button>
      </div>
      <small className="oauth-consent-note">Market Signal never gives this client your password. You can revoke access from Account → Connected apps.</small>
    </section>
  </main>;
}
