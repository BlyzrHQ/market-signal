"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { accountNavigationDestination } from "../lib/account-report-redirect.ts";

const ACCOUNT_DESTINATION = { authenticated: false, href: "/account" };

export function AccountNavigationLink({ ar }: { ar: boolean }) {
  const [destination, setDestination] = useState(ACCOUNT_DESTINATION);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void fetch("/api/account/reports", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (active) setDestination(accountNavigationDestination(payload));
    }).catch(() => {
      // The public header fails closed to the account route when private history is unavailable.
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const label = destination.authenticated
    ? ar ? "تقاريري" : "My reports"
    : ar ? "الحساب" : "Account";
  return <Link
    className="header-workspace-link"
    href={destination.href}
    aria-label={destination.authenticated
      ? ar ? "افتح لوحة تقاريري" : "Open my reports dashboard"
      : ar ? "افتح الحساب" : "Open account"}
  >{destination.authenticated && <i aria-hidden="true" />}{label}</Link>;
}
