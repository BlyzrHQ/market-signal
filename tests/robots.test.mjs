import assert from "node:assert/strict";
import test from "node:test";

import { parseRobots } from "../app/lib/robots.ts";

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
  const policy = parseRobots(`User-agent: *\nDisallow: /private\nUser-agent: MarketSignalPublicScanner\nAllow: /private`);
  assert.equal(policy.allows("/private"), true);
});

test("end anchors and empty disallow directives follow robots semantics", () => {
  const policy = parseRobots(`User-agent: *\nDisallow:\nDisallow: /file$`);
  assert.equal(policy.allows("/file"), false);
  assert.equal(policy.allows("/file/more"), true);
  assert.equal(policy.allows("/anything"), true);
});
