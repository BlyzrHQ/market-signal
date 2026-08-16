"use client";

import { useState } from "react";

export function CheckoutButton({ plan, label }: { plan: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function checkout() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const result = await response.json().catch(() => ({})) as { url?: string; error?: string };
      if (response.status === 401) {
        window.location.assign(`/account?plan=${encodeURIComponent(plan)}`);
        return;
      }
      if (!response.ok || !result.url) throw new Error(result.error || "Checkout is unavailable.");
      window.location.assign(result.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Checkout is unavailable.");
      setBusy(false);
    }
  }
  return <div className="checkout-action"><button type="button" onClick={checkout} disabled={busy}>{busy ? "Opening checkout…" : label} <span>→</span></button>{error && <small role="alert">{error}</small>}</div>;
}
