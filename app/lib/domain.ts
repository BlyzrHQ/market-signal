export function normalizeDomain(input: string) {
  const candidate = input.trim();
  if (!candidate) throw new Error("Enter a domain to analyze.");
  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only public HTTP domains can be analyzed.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1" || hostname === "169.254.169.254" || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^(fc|fd|fe80):/i.test(hostname)) {
    throw new Error("Private or local addresses cannot be analyzed.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = "/";
  return url;
}

export function canonicalDomain(input: string) {
  try {
    return normalizeDomain(input).hostname.replace(/^www\./, "");
  } catch {
    return input.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
  }
}
