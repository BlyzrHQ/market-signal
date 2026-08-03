function product(domain, index) {
  return {
    id: `${domain}-${index}`,
    domain,
    name: `منتج بقلاوة Product ${index}`,
    normalizedName: `product ${index}`,
    description: "وصف طويل ".repeat(400),
    category: "sweets",
    sourceUrl: `https://${domain}/product/${index}`,
    imageUrl: `https://cdn.${domain}/product-${index}.jpg`,
    priceSignals: [{ raw: `USD ${index + 1}`, currency: "USD", amount: index + 1 }],
    quantity: { kind: "mass", amount: 500, unit: "g" },
    identifiers: { gtins: [], sku: `SKU-${index}`, brand: "Public Brand" },
    attributes: ["duplicated evidence ".repeat(100)],
    claimIds: Array.from({ length: 20 }, (_, claim) => `${domain}-${index}-${claim}`),
    observedAt: "2026-08-03T00:00:00.000Z",
    extraction: "json-ld",
    confidence: "Medium",
    jsonLdType: "Product",
    ownership: "path-inferred",
  };
}

export function babanujScaleDocument() {
  const domains = Array.from({ length: 7 }, (_, index) => `shop-${index}.test`);
  const blocks = [
    { type: "summary", id: "summary", title: "Verified market", body: "Useful source-linked result" },
    { type: "market-profile", id: "market", category: "Middle Eastern grocery", region: "United States" },
    { type: "experience-benchmark", id: "benchmark", metrics: [] },
  ];
  for (const [domainIndex, domain] of domains.entries()) {
    const count = domainIndex === 0 ? 81 : domainIndex === 1 ? 434 : 430;
    const products = Array.from({ length: count }, (_, index) => product(domain, index));
    blocks.push({ type: "competitor", id: `competitor-${domain}`, domain, websiteSourceUrl: `https://${domain}/` });
    blocks.push({ type: "coverage", id: `coverage-${domain}`, domain, pagesRequested: 64, pagesFetched: 60, gaps: [] });
    blocks.push({ type: "company", id: `company-${domain}`, domain, description: "Company description ".repeat(400), pages: Array.from({ length: 80 }, (_, index) => ({ url: `https://${domain}/page/${index}`, title: `Page ${index}`, claimIds: Array.from({ length: 20 }, (_, claim) => `${index}-${claim}`) })) });
    blocks.push({ type: "product-catalog", id: `catalog-${domain}`, domain, products });
  }
  for (let index = 0; index < 300; index += 1) blocks.push({ type: "evidence", id: `evidence-${index}`, text: "Repeated public evidence ".repeat(200), sourceUrl: `https://shop-0.test/page/${index}` });
  for (let index = 0; index < 120; index += 1) blocks.push({ type: "gap", id: `gap-${index}`, reason: "A visible source limitation ".repeat(100), url: `https://shop-0.test/gap/${index}` });
  const primaryProducts = Array.from({ length: 23 }, (_, index) => product(domains[0], index));
  blocks.push({
    type: "product-comparison",
    id: "product-comparison",
    rows: primaryProducts.map((primary, index) => ({ primary, matches: [{ product: product(domains[1], index), score: 0.9, assessment: { reasons: ["same product".repeat(100)], contradictions: [] } }] })),
    unmatched: [{ domain: domains[1], products: Array.from({ length: 200 }, (_, index) => product(domains[1], index + 1000)) }],
  });
  return { primaryDomain: domains[0], document: { version: "1", blocks }, marketBrief: null };
}
