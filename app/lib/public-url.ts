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

function mappedIpv4(host: string) {
  if (!host.startsWith("::ffff:")) return null;
  const tail = host.slice(7);
  if (tail.includes(".")) return tail;
  const words = tail.split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return "invalid";
  const value = (Number.parseInt(words[0], 16) * 65_536) + Number.parseInt(words[1], 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export function isPublicHostname(value: string) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return publicIpv4(host);
  if (host.includes(":")) {
    const mapped = mappedIpv4(host);
    if (mapped !== null) return mapped !== "invalid" && publicIpv4(mapped);
    if (host === "::" || host === "::1" || /^(?:fc|fd|fe[89a-f]|ff)/i.test(host) || /^2001:(?:db8|0?10):/i.test(host) || /^64:ff9b:1:/i.test(host)) return false;
    return /^[0-9a-f:]+$/i.test(host);
  }
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
