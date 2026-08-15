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

function ipv6Words(host: string) {
  let source = host;
  if (source.includes(".")) {
    const separator = source.lastIndexOf(":");
    const parts = source.slice(separator + 1).split(".").map(Number);
    if (separator < 0 || parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    source = `${source.slice(0, separator)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  if ((source.match(/::/g) || []).length > 1) return null;
  const [leftText, rightText] = source.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  const omitted = source.includes("::") ? 8 - left.length - right.length : 0;
  if (omitted < 0 || (!source.includes("::") && left.length !== 8)) return null;
  const words = [...left, ...Array.from({ length: omitted }, () => "0"), ...right].map((word) => Number.parseInt(word, 16));
  return words.length === 8 ? words : null;
}

function embeddedIpv4(host: string) {
  const words = ipv6Words(host);
  if (!words) return null;
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const compatible = words.slice(0, 6).every((word) => word === 0);
  const wellKnownNat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
  if (!mapped && !compatible && !wellKnownNat64) return null;
  return [words[6] >>> 8, words[6] & 255, words[7] >>> 8, words[7] & 255].join(".");
}

export function isPublicHostname(value: string) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return publicIpv4(host);
  if (host.includes(":")) {
    const embedded = embeddedIpv4(host);
    if (embedded !== null) return publicIpv4(embedded);
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
