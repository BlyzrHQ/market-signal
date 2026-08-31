import { errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import type { ShopifyConfig } from "./config.ts";
import { ShopifyShopDomainError, shopifyShopFromUrlClaim } from "./shop-domain.ts";

const MAX_TOKEN_LENGTH = 16_384;
const SUBJECT_PATTERN = /^[1-9]\d{0,39}$/;
const CLOCK_TOLERANCE_SECONDS = 5;

export type VerifiedShopifyIdToken = {
  expiresAt: number;
  issuedAt: number | null;
  shop: string;
  staffSubject: string;
};

export class ShopifyAuthenticationError extends Error {
  readonly retryWithFreshToken: boolean;

  constructor(retryWithFreshToken = false) {
    super("Shopify authentication failed.");
    this.name = "ShopifyAuthenticationError";
    this.retryWithFreshToken = retryWithFreshToken;
  }
}

export function shopifyBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) throw new ShopifyAuthenticationError();
  return match[1];
}

function requiredNumericDate(payload: JWTPayload, name: "exp" | "nbf"): number {
  const value = payload[name];
  if (!Number.isInteger(value) || Number(value) <= 0) throw new ShopifyAuthenticationError();
  return Number(value);
}

export async function verifyShopifyIdToken(
  token: string,
  config: Pick<ShopifyConfig, "clientId" | "clientSecret">,
  now = new Date(),
): Promise<VerifiedShopifyIdToken> {
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new ShopifyAuthenticationError();
  try {
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(config.clientSecret),
      {
        algorithms: ["HS256"],
        audience: config.clientId,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: now,
      },
    );
    if (protectedHeader.alg !== "HS256") throw new ShopifyAuthenticationError();
    const expiresAt = requiredNumericDate(payload, "exp");
    requiredNumericDate(payload, "nbf");
    if (typeof payload.sub !== "string" || !SUBJECT_PATTERN.test(payload.sub)) {
      throw new ShopifyAuthenticationError();
    }
    const issuerShop = shopifyShopFromUrlClaim(payload.iss);
    const destinationShop = shopifyShopFromUrlClaim(payload.dest);
    if (issuerShop !== destinationShop) throw new ShopifyAuthenticationError();
    return {
      expiresAt,
      issuedAt: Number.isInteger(payload.iat) && Number(payload.iat) > 0 ? Number(payload.iat) : null,
      shop: destinationShop,
      staffSubject: payload.sub,
    };
  } catch (error) {
    if (error instanceof ShopifyAuthenticationError) throw error;
    if (error instanceof ShopifyShopDomainError) throw new ShopifyAuthenticationError();
    if (error instanceof joseErrors.JWTExpired) throw new ShopifyAuthenticationError(true);
    throw new ShopifyAuthenticationError();
  }
}

export function shopifyAuthenticationResponse(error: ShopifyAuthenticationError): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (error.retryWithFreshToken) headers.set("X-Shopify-Retry-Invalid-Session-Request", "1");
  return Response.json(
    { code: "shopify_authentication_failed", error: "Refresh the Shopify session and try again." },
    { status: 401, headers },
  );
}
