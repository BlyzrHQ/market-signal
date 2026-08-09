"use client";

import posthog from "posthog-js";
import { buildProductAnalyticsEvent, sanitizePostHogEvent, type ProductAnalyticsEventName, type ProductAnalyticsPayloads } from "./product-analytics";

const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";
let initialized = false;

function configuredHost(): string {
  const candidate = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  if (!candidate) return DEFAULT_POSTHOG_HOST;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" ? url.origin : DEFAULT_POSTHOG_HOST;
  } catch {
    return DEFAULT_POSTHOG_HOST;
  }
}

function replayEnabled(): boolean {
  return process.env.NEXT_PUBLIC_POSTHOG_SESSION_REPLAY?.trim().toLowerCase() === "true";
}

export function initializeProductAnalytics(): boolean {
  if (initialized) return true;
  if (typeof window === "undefined") return false;
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
  if (!token) return false;
  try {
    posthog.init(token, {
      api_host: configuredHost(),
      defaults: "2026-05-30",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      person_profiles: "never",
      cookieless_mode: "always",
      respect_dnt: true,
      disable_session_recording: !replayEnabled(),
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
        maskAllElementAttributes: true,
        canvasCapture: { maskRegionsFn: () => null },
        recordCrossOriginIframes: false,
      },
      before_send: (event) => sanitizePostHogEvent(event) as unknown as typeof event,
      loaded: () => { initialized = true; },
    });
    initialized = true;
    return true;
  } catch {
    return false;
  }
}

export function captureProductEvent<N extends ProductAnalyticsEventName>(name: N, properties: ProductAnalyticsPayloads[N]): void {
  try {
    const envelope = buildProductAnalyticsEvent(name, properties);
    if (!envelope || !initializeProductAnalytics()) return;
    posthog.capture(envelope.event, envelope.properties);
  } catch {
    // Analytics is observational and must never affect the product workflow.
  }
}
