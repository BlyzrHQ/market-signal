import { canonicalDomain } from "./domain.ts";

const COUNTRY_CODE = /^[A-Z]{2}$/;
const LOCALE_PREFIX = /^\/([a-z]{2,3})-([a-z]{2})(\/.*)$/i;
const MARKET_QUERY = /^(?:country|country_code|countrycode|market|region|locale|currency|currency_code|currencycode)$/i;

function normalizedPath(pathname: string) {
  const value = pathname.replace(/\/{2,}/g, "/");
  return value.length > 1 ? value.replace(/\/$/, "") : value;
}

/**
 * Builds one same-origin market retry only when a storefront inserted a
 * conflicting locale prefix during an HTTP redirect. Explicit market selectors
 * on the evidence URL are never overridden.
 */
export function redirectedMarketRetryUrl(requestedUrl: string, fetchedUrl: string, targetCountryCode: string) {
  const country = targetCountryCode.trim().toUpperCase();
  if (!COUNTRY_CODE.test(country)) return "";

  let requested: URL;
  let fetched: URL;
  try {
    requested = new URL(requestedUrl);
    fetched = new URL(fetchedUrl);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(requested.protocol) || !/^https?:$/.test(fetched.protocol)) return "";
  if (canonicalDomain(requested.hostname) !== canonicalDomain(fetched.hostname)) return "";
  if ([...requested.searchParams.keys()].some((key) => MARKET_QUERY.test(key))) return "";
  if (LOCALE_PREFIX.test(requested.pathname)) return "";

  const localized = fetched.pathname.match(LOCALE_PREFIX);
  if (!localized || localized[2].toUpperCase() === country) return "";
  if (normalizedPath(localized[3]) !== normalizedPath(requested.pathname)) return "";

  fetched.pathname = `/${localized[1]}-${country.toLowerCase()}${localized[3]}`;
  fetched.hash = "";
  return fetched.toString();
}
