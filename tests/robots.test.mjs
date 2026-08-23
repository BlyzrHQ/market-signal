import assert from "node:assert/strict";
import test from "node:test";

import { parseRobots, robotsAvailability } from "../app/lib/robots.ts";

const shopifyRobots = `
User-agent: *
Allow: /
Allow: /products/account
Disallow: /admin
Disallow: /checkout
Disallow: /*?*preview_theme_id=*
Disallow: /*/account

User-agent: adsbot-google
Disallow: /

Sitemap: https://myjam.co.uk/sitemap.xml
`;

test("Shopify wildcard query rules do not block the public homepage", () => {
  const policy = parseRobots(shopifyRobots);
  assert.equal(policy.allows("/"), true);
  assert.equal(policy.allows("/products/jam"), true);
  assert.equal(policy.allows("/?preview_theme_id=123"), false);
  assert.equal(policy.allows("/admin"), false);
  assert.deepEqual(policy.sitemaps, ["https://myjam.co.uk/sitemap.xml"]);
});

test("the longest matching rule wins and Allow wins an equal-length tie", () => {
  const policy = parseRobots(`User-agent: *\nDisallow: /products\nAllow: /products/public\nDisallow: /same\nAllow: /same`);
  assert.equal(policy.allows("/products/private"), false);
  assert.equal(policy.allows("/products/public/item"), true);
  assert.equal(policy.allows("/same"), true);
});

test("specific user-agent groups override the wildcard group", () => {
  const policy = parseRobots(`User-agent: *\nDisallow: /private\nUser-agent: MarketSignal\nAllow: /private`);
  assert.equal(policy.allows("/private"), true);
});

test("legacy crawler opt-outs remain binding after the identity rename", () => {
  const policy = parseRobots(`User-agent: *\nAllow: /\nUser-agent: MarketSignalPublicScanner\nDisallow: /`);
  assert.equal(policy.allows("/"), false);
});

test("the longer legacy crawler group conservatively wins when both identities are present", () => {
  const policy = parseRobots(`User-agent: MarketSignal\nAllow: /private\nUser-agent: MarketSignalPublicScanner\nDisallow: /private`);
  assert.equal(policy.allows("/private"), false);
});

test("unrelated crawler directives do not apply to Market Signal", () => {
  const policy = parseRobots(`User-agent: SomeOtherBot\nDisallow: /`);
  assert.equal(policy.allows("/"), true);
});

test("end anchors and empty disallow directives follow robots semantics", () => {
  const policy = parseRobots(`User-agent: *\nDisallow:\nDisallow: /file$`);
  assert.equal(policy.allows("/file"), false);
  assert.equal(policy.allows("/file/more"), true);
  assert.equal(policy.allows("/anything"), true);
});

test("robots availability distinguishes an absent policy from an unreachable policy", () => {
  assert.equal(robotsAvailability({ ok: true, status: 200 }), "available");
  assert.equal(robotsAvailability({ ok: false, status: 404 }), "missing");
  assert.equal(robotsAvailability({ ok: false, status: 410 }), "missing");
  assert.equal(robotsAvailability({ ok: false, status: 429 }), "unreachable");
  assert.equal(robotsAvailability({ ok: false, status: 503 }), "unreachable");
  assert.equal(robotsAvailability(null), "unreachable");
});
