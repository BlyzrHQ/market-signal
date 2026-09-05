import { isPublicRoutableHost } from "@better-auth/core/utils/host";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

type PinnedAddress = {
  address: string;
  family: 4 | 6;
};

type LookupOptions = {
  all?: boolean;
};

type LookupOneCallback = (
  error: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;

type LookupAllCallback = (
  error: NodeJS.ErrnoException | null,
  addresses: PinnedAddress[],
) => void;

const BODY_FORBIDDEN_RESPONSE_STATUSES = new Set([204, 205, 304]);

function responseHeaders(headers: Record<string, string | string[] | undefined>) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
}

/**
 * Return a DNS callback pinned to one pre-validated address.
 *
 * Node 22 can ask a custom lookup callback for either one address or an
 * `all: true` array while auto-family selection is active. Supporting both
 * shapes prevents the ERR_INVALID_IP_ADDRESS failure in the upstream CIMD
 * Node transport while preserving resolve-once connection pinning.
 */
export function createPinnedLookup(pinnedAddress: PinnedAddress): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    const lookupOptions = typeof options === "object" ? options as LookupOptions : {};
    if (lookupOptions.all) {
      (callback as LookupAllCallback)(null, [pinnedAddress]);
      return;
    }
    (callback as LookupOneCallback)(null, pinnedAddress.address, pinnedAddress.family);
  };
}

/**
 * Fetch a CIMD-owned HTTPS resource with resolve-once DNS validation,
 * connection pinning, no redirect following, and Node 22-compatible address
 * family handling.
 */
export const fetchPinnedClientMetadataResource: ClientMetadataResourceFetch = async (input, init) => {
  const webRequest = new Request(input, init);
  const url = new URL(webRequest.url);
  if (url.protocol !== "https:") {
    throw new TypeError("CIMD Node transport requires an HTTPS URL");
  }
  if (webRequest.method !== "GET" && webRequest.method !== "HEAD") {
    throw new TypeError("CIMD Node transport supports only GET and HEAD");
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new TypeError("metadata hostname returned no DNS addresses");
  }
  for (const result of addresses) {
    if (!isPublicRoutableHost(result.address)) {
      throw new TypeError("metadata hostname must resolve only to public-routable addresses");
    }
  }

  const selected = addresses.find((address) => address.family === 4) ?? addresses[0];
  const pinnedAddress: PinnedAddress = {
    address: selected.address,
    family: selected.family as 4 | 6,
  };
  const headers: Record<string, string> = {};
  webRequest.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers.host = url.host;
  const signal = init?.signal ?? (input instanceof Request ? input.signal : webRequest.signal);

  return new Promise((resolve, reject) => {
    const clientRequest = request(url, {
      agent: false,
      family: pinnedAddress.family,
      headers,
      lookup: createPinnedLookup(pinnedAddress),
      method: webRequest.method,
      servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 ? url.hostname : undefined,
      signal,
    }, (response) => {
      const status = response.statusCode ?? 500;
      const body = webRequest.method === "HEAD" || BODY_FORBIDDEN_RESPONSE_STATUSES.has(status)
        ? null
        : Readable.toWeb(response);
      resolve(new Response(body, {
        headers: responseHeaders(response.headers),
        status,
        statusText: response.statusMessage,
      }));
    });
    clientRequest.once("error", reject);
    clientRequest.end();
  });
};
