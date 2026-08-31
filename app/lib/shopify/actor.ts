import type Database from "better-sqlite3";
import { shopifyConfigFromProcessEnvironment, type ShopifyConfig } from "./config.ts";
import { shopifyBearerToken, verifyShopifyIdToken } from "./id-token.ts";
import {
  openShopifyDatabase,
  resolveShopifyActor,
  type ShopifyActorContext,
} from "./store.ts";

export type ShopifyActorServices = {
  config: () => ShopifyConfig;
  openDatabase: (databasePath: string) => Promise<Database.Database>;
  verifyIdToken: typeof verifyShopifyIdToken;
};

const defaultServices: ShopifyActorServices = {
  config: shopifyConfigFromProcessEnvironment,
  openDatabase: openShopifyDatabase,
  verifyIdToken: verifyShopifyIdToken,
};

export async function shopifyActorContext(
  request: Request,
  services: ShopifyActorServices = defaultServices,
): Promise<ShopifyActorContext> {
  const config = services.config();
  const token = shopifyBearerToken(request);
  const verified = await services.verifyIdToken(token, config);
  const database = await services.openDatabase(config.databasePath);
  try {
    return resolveShopifyActor(database, {
      shop: verified.shop,
      staffSubject: verified.staffSubject,
      requiredScopes: config.requiredScopes,
    });
  } finally {
    database.close();
  }
}
