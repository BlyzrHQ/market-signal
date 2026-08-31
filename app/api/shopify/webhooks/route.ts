import type Database from "better-sqlite3";
import {
  shopifyConfigFromProcessEnvironment,
  ShopifyConfigurationError,
  type ShopifyConfig,
} from "../../../lib/shopify/config.ts";
import {
  openShopifyDatabase,
  processShopifyWebhook,
  ShopifyStoreError,
} from "../../../lib/shopify/store.ts";
import {
  ShopifyWebhookError,
  verifyShopifyWebhookRequest,
} from "../../../lib/shopify/webhooks.ts";

type WebhookServices = {
  config: () => ShopifyConfig;
  openDatabase: (databasePath: string) => Promise<Database.Database>;
  verify: typeof verifyShopifyWebhookRequest;
};

const defaultServices: WebhookServices = {
  config: shopifyConfigFromProcessEnvironment,
  openDatabase: openShopifyDatabase,
  verify: verifyShopifyWebhookRequest,
};

function webhookError(code: string, status: number): Response {
  return Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
}

export async function handleShopifyWebhook(request: Request, services: WebhookServices = defaultServices): Promise<Response> {
  let config: ShopifyConfig;
  try {
    config = services.config();
  } catch (error) {
    if (error instanceof ShopifyConfigurationError) return webhookError("shopify_not_configured", 503);
    return webhookError("shopify_webhook_unavailable", 503);
  }

  try {
    const event = await services.verify(request, config.clientSecret);
    const database = await services.openDatabase(config.databasePath);
    try {
      const receipt = processShopifyWebhook(database, event, config.requiredScopes);
      return Response.json(
        { received: true, duplicate: receipt.duplicate, result: receipt.result },
        { headers: { "cache-control": "no-store" } },
      );
    } finally {
      database.close();
    }
  } catch (error) {
    if (error instanceof ShopifyWebhookError) return webhookError(error.code, error.httpStatus);
    if (error instanceof ShopifyStoreError) return webhookError(error.code, error.httpStatus);
    return webhookError("shopify_webhook_unavailable", 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleShopifyWebhook(request);
}
