function publicIpv4(host: string) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99) || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function isPublicHostname(value: string) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return publicIpv4(host);
  // Market Signal accepts public DNS names and IPv4 literals. Direct IPv6
  // literals are outside the domain-in product contract and are rejected
  // because organization-specific NAT64 and ISATAP routes cannot be inferred
  // safely from an address alone.
  if (host.includes(":")) return false;
  return host.includes(".") && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) && !host.includes("..") && host.length <= 253;
}

export function publicHttpUrl(value: unknown, allowEmpty = true, limit = 2_000) {
  const candidate = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
  if (!candidate && allowEmpty) return "";
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || !isPublicHostname(parsed.hostname)) throw new Error();
    return parsed.toString();
  } catch {
    throw new Error("Invalid report fact URL.");
  }
}
