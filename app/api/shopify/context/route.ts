import {
  shopifyAuthenticationResponse,
  ShopifyAuthenticationError,
} from "../../../lib/shopify/id-token.ts";
import {
  ShopifyConfigurationError,
} from "../../../lib/shopify/config.ts";
import { shopifyActorContext, type ShopifyActorServices } from "../../../lib/shopify/actor.ts";
import { ShopifyStoreError } from "../../../lib/shopify/store.ts";

function contextError(code: string, error: string, status: number): Response {
  return Response.json({ code, error }, { status, headers: { "cache-control": "no-store" } });
}

export async function handleShopifyContext(request: Request, services?: ShopifyActorServices): Promise<Response> {
  try {
    const actor = await shopifyActorContext(request, services);
    return Response.json(
      {
        shop: actor.shop,
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        installState: actor.installState,
        requiredScopesGranted: actor.requiredScopesGranted,
        scopes: actor.scopes,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ShopifyConfigurationError) {
      return contextError("shopify_not_configured", "Shopify is not configured on this deployment.", 503);
    }
    if (error instanceof ShopifyAuthenticationError) return shopifyAuthenticationResponse(error);
    if (error instanceof ShopifyStoreError) {
      const message = error.httpStatus === 404 ? "The Shopify installation was not found." : "Shopify storage is temporarily unavailable.";
      return contextError(error.code, message, error.httpStatus);
    }
    return contextError("shopify_unavailable", "Shopify is temporarily unavailable.", 503);
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleShopifyContext(request);
}
