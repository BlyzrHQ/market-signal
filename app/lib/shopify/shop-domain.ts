const SHOP_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.myshopify\.com$/;

export class ShopifyShopDomainError extends Error {
  constructor() {
    super("The Shopify shop domain is invalid.");
    this.name = "ShopifyShopDomainError";
  }
}

export function canonicalShopifyShop(input: unknown): string {
  if (typeof input !== "string") throw new ShopifyShopDomainError();
  const candidate = input.trim().toLowerCase();
  if (candidate.length > 255 || !SHOP_PATTERN.test(candidate)) throw new ShopifyShopDomainError();
  return candidate;
}

export function shopifyShopFromUrlClaim(input: unknown): string {
  if (typeof input !== "string" || input.length > 500) throw new ShopifyShopDomainError();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ShopifyShopDomainError();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) throw new ShopifyShopDomainError();
  return canonicalShopifyShop(url.hostname);
}

export function shopifyFrameAncestors(shop: string): string {
  const canonical = canonicalShopifyShop(shop);
  return `https://admin.shopify.com https://${canonical}`;
}

export function shopifyIssuer(shop: string): string {
  return `shopify:${canonicalShopifyShop(shop)}`;
}
