import assert from "node:assert/strict";
import test from "node:test";

import { prioritizedSitemapDocuments } from "../app/api/crawl/route.ts";

test("product sitemap ranking examines the path rather than a product-like hostname", () => {
  const urls = [
    "https://fellowproducts.com/sitemap_blogs_1.xml",
    "https://fellowproducts.com/sitemap_collections_1.xml",
    "https://fellowproducts.com/sitemap_metaobjects_1.xml",
    "https://fellowproducts.com/sitemap_pages_1.xml",
    "https://fellowproducts.com/sitemap_products_1.xml",
  ];

  assert.deepEqual(prioritizedSitemapDocuments(urls, 4), [
    "https://fellowproducts.com/sitemap_products_1.xml",
    "https://fellowproducts.com/sitemap_collections_1.xml",
    "https://fellowproducts.com/sitemap_blogs_1.xml",
    "https://fellowproducts.com/sitemap_metaobjects_1.xml",
  ]);
});

test("product sitemap ranking handles encoded and localized product paths", () => {
  const urls = [
    "https://shop.test/sitemap_pages.xml",
    "https://shop.test/en/sitemap_catalog.xml",
    "https://shop.test/sitemaps/%70roducts-2.xml",
  ];

  assert.deepEqual(prioritizedSitemapDocuments(urls, 2), [
    "https://shop.test/sitemaps/%70roducts-2.xml",
    "https://shop.test/en/sitemap_catalog.xml",
  ]);
});
