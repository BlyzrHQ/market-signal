export type ChatGPTUser = {
  displayName: string;
  email: string;
  fullName: string | null;
};

type ChatGPTIdentityEnvironment = {
  MARKET_SIGNAL_DEPLOY_TARGET?: string;
  MARKET_SIGNAL_TRUST_CHATGPT_AUTH_HEADERS?: string;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";

export function chatGPTUserFromHeaders(
  requestHeaders: Pick<Headers, "get">,
  environment: ChatGPTIdentityEnvironment,
): ChatGPTUser | null {
  if (!mayTrustChatGPTIdentityHeaders(environment)) return null;

  const email = requestHeaders.get(USER_EMAIL_HEADER);
  if (!email) return null;

  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName =
    encodedFullName &&
    requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    displayName: fullName ?? email,
    email,
    fullName,
  };
}

export function mayTrustChatGPTIdentityHeaders(
  environment: ChatGPTIdentityEnvironment,
): boolean {
  return (
    environment.MARKET_SIGNAL_DEPLOY_TARGET === "sites" &&
    environment.MARKET_SIGNAL_TRUST_CHATGPT_AUTH_HEADERS === "true"
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
