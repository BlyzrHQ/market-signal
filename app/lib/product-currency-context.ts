import { isSupportedCurrency } from "./product-intelligence.ts";

const MARKET_KEY = /^(country|country_code|countrycode|market|region|locale|currency|currency_code|currencycode)$/i;

/** A request preference, never proof of the currency of a returned amount. */
export function productCurrencyRequestUrl(source: string, currency: string) {
  if (!isSupportedCurrency(currency)) return source;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || !/^\/products\/[^/]+\/?$/.test(url.pathname)) return source;
    if ([...url.searchParams.keys()].some(key => MARKET_KEY.test(key))) return source;
    url.searchParams.set("currency", currency);
    return url.toString();
  } catch { return source; }
}

/** Only the single currency selector whose context the product adapter retains. */
export function soleProductCurrencySelector(source: string) {
  try {
    const url = new URL(source);
    const selectors = [...url.searchParams].filter(([key]) => MARKET_KEY.test(key));
    if (selectors.length !== 1 || selectors[0][0] !== "currency") return "";
    return isSupportedCurrency(selectors[0][1]) ? selectors[0][1] : "";
  } catch { return ""; }
}
