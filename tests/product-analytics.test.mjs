import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildProductAnalyticsEvent,
  sanitizePostHogEvent,
} from "../app/lib/product-analytics.ts";

test("product analytics accepts only the documented event properties", () => {
  assert.deepEqual(buildProductAnalyticsEvent("report_requested", {
    locale: "en",
    input_kind: "domain",
    primaryDomain: "private.example",
    publicId: "secret-report-id",
    query: "?customer=private",
  }), {
    event: "report_requested",
    properties: { locale: "en", input_kind: "domain" },
  });
});

test("the final PostHog guard strips URLs, domains, identifiers, and free text", () => {
  const sanitized = sanitizePostHogEvent({
    event: "report_section_viewed",
    $set: { email: "private@example.com" },
    $set_once: { company: "Private Company" },
    $unset: ["private-property"],
    properties: {
      section: "products",
      layout: "table",
      report_status: "complete",
      plan_key: "growth",
      primaryDomain: "private.example",
      publicId: "private-report-id",
      productName: "Private Product",
      free_text: "customer supplied content",
      $current_url: "https://signal.example/reports/private-report-id?view=products",
      $pathname: "/reports/private-report-id",
      $referrer: "https://search.example/private-query",
      $browser: "Chrome",
      $viewport_width: 1440,
    },
  });

  assert.deepEqual(sanitized?.properties, {
    $browser: "Chrome",
    $viewport_width: 1440,
    section: "products",
    layout: "table",
    report_status: "complete",
    plan_key: "growth",
  });
  assert.equal("$set" in sanitized, false);
  assert.equal("$set_once" in sanitized, false);
  assert.equal("$unset" in sanitized, false);
  assert.equal(sanitizePostHogEvent({ event: "$dead_click", properties: { $current_url: "https://private.example" } }), null);
});

test("unknown enum values cannot create high-cardinality analytics fields", () => {
  assert.deepEqual(buildProductAnalyticsEvent("report_viewed", {
    report_status: "customer-specific-state",
    plan_key: "private-enterprise-plan",
    has_competitors: true,
    has_product_matches: false,
  }), {
    event: "report_viewed",
    properties: {
      report_status: "unknown",
      plan_key: "unknown",
      has_competitors: true,
      has_product_matches: false,
    },
  });
});

test("the browser integration is inert without a token and privacy-safe by default", () => {
  const client = fs.readFileSync(new URL("../app/lib/product-analytics-client.ts", import.meta.url), "utf8");
  assert.match(client, /if \(!token\) return false/);
  assert.match(client, /autocapture: false/);
  assert.match(client, /capture_pageview: false/);
  assert.match(client, /person_profiles: "never"/);
  assert.match(client, /cookieless_mode: "always"/);
  assert.match(client, /respect_dnt: true/);
  assert.match(client, /disable_session_recording: !replayEnabled\(\)/);
  assert.match(client, /maskAllInputs: true/);
  assert.match(client, /maskTextSelector: "\*"/);
  assert.match(client, /maskAllElementAttributes: true/);
  assert.match(client, /canvasCapture: \{ maskRegionsFn: \(\) => null \}/);
  assert.doesNotMatch(client, /posthog\.identify/);
});
