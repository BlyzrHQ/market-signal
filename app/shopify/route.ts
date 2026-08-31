import { randomBytes } from "node:crypto";
import {
  shopifyConfigFromEnvironment,
  ShopifyConfigurationError,
} from "../lib/shopify/config.ts";
import {
  canonicalShopifyShop,
  ShopifyShopDomainError,
  shopifyFrameAncestors,
} from "../lib/shopify/shop-domain.ts";

function escaped(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function shellError(code: string, message: string, status: number): Response {
  return Response.json({ code, error: message }, { status, headers: { "cache-control": "no-store" } });
}

export function shopifyAppHomeResponse(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): Response {
  try {
    const config = shopifyConfigFromEnvironment(environment);
    const shop = canonicalShopifyShop(new URL(request.url).searchParams.get("shop"));
    const nonce = randomBytes(18).toString("base64");
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="shopify-api-key" content="${escaped(config.clientId)}">
    <title>Market Signal for Shopify</title>
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
    <style nonce="${nonce}">
      :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;background:#071812;color:#eaf8f0}main{max-width:760px;margin:0 auto;padding:48px 24px}p{color:#a8c9ba;line-height:1.6}.status{display:inline-flex;padding:6px 10px;border:1px solid #285443;border-radius:999px;color:#79ecb3}#detail{min-height:1.5em}
    </style>
  </head>
  <body>
    <main>
      <span class="status">Shopify connection</span>
      <h1>Market Signal</h1>
      <p id="detail">Securing this shop connection…</p>
    </main>
    <script nonce="${nonce}">
      (async()=>{const detail=document.getElementById("detail");try{const token=await shopify.idToken();const headers={authorization:"Bearer "+token};let response=await fetch("/api/shopify/context",{headers});if(response.status===404){response=await fetch("/api/shopify/bootstrap",{method:"POST",headers});}if(!response.ok)throw new Error("connection");const state=await response.json();detail.textContent=state.requiredScopesGranted?"Shop connected. Catalog access is ready for the next setup step.":"Shop connected, but product access needs attention.";}catch{detail.textContent="The secure Shopify connection could not be completed. Reopen the app and try again.";}})();
    </script>
  </body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store, max-age=0",
        "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://cdn.shopify.com; style-src 'self' 'nonce-${nonce}'; img-src 'self' data: https:; connect-src 'self' https://*.shopify.com https://*.myshopify.com; frame-ancestors ${shopifyFrameAncestors(shop)}; base-uri 'self'; form-action 'self'`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    });
  } catch (error) {
    if (error instanceof ShopifyConfigurationError) {
      return shellError("shopify_not_configured", "Shopify is not configured on this deployment.", 503);
    }
    if (error instanceof ShopifyShopDomainError) {
      return shellError("invalid_shop", "Use a valid Shopify shop domain.", 400);
    }
    return shellError("shopify_unavailable", "Shopify is temporarily unavailable.", 503);
  }
}

export async function GET(request: Request): Promise<Response> {
  return shopifyAppHomeResponse(request);
}
