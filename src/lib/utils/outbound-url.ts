/**
 * Guard for outbound requests to user supplied URLs.
 *
 * Gitea Mirror talks to hosts on private networks by design: the Gitea it
 * mirrors to usually lives on a LAN address, a Docker service name or
 * localhost, and so do ntfy and Gotify. Blocking private ranges would break
 * the normal deployment, so this guard is deliberately narrow. It refuses
 * the addresses that are never a legitimate destination for this app and
 * are the classic SSRF targets:
 *
 * - the IPv4 link local range 169.254.0.0/16, which carries the cloud
 *   instance metadata service on AWS, GCP, Azure, DigitalOcean and others
 * - the IPv6 link local range fe80::/10 and the IPv4 mapped form of the
 *   same range
 * - the well known metadata host names
 * - anything that is not plain http or https
 *
 * Host names are resolved and every address they resolve to is checked, so
 * a DNS name pointing at the metadata range is refused too. A plain http
 * request is then sent to the address that was checked, with the original
 * name in the Host header, so a name that changes its answer between the
 * check and the request (DNS rebinding) gains nothing. An https request
 * keeps the name: the certificate is validated against it, and the
 * metadata services this guard exists for speak no TLS at all. `safeFetch`
 * never follows a redirect; `guardedFetch` follows them itself and checks
 * every hop.
 *
 * That narrow rule is for URLs the operator or a signed in user chose. A URL
 * nobody here chose, such as a release asset link written by the owner of a
 * repository being mirrored, gets the `publicOnly` rule on top: nothing on a
 * private network, and no credentials.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** True for an address in 169.254.0.0/16 or fe80::/10 (including v4 mapped). */
export function isLinkLocalAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 169 && b === 254;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    // ::ffff:169.254.x.y (dotted form)
    const mapped = lower.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isLinkLocalAddress(mapped[1]);
    // ::ffff:a9fe:xxxx (hex form of 169.254.0.0/16)
    if (/^(?:0*:)*ffff:a9fe:[0-9a-f]{1,4}$/.test(lower)) return true;
    // fe80::/10 covers fe80 to febf
    return /^fe[89ab][0-9a-f]:/.test(lower);
  }
  return false;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isNonPublicIpv4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // protocol assignments, documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The eight groups of an IPv6 address, or null when it cannot be expanded. */
function expandIpv6(address: string): number[] | null {
  const lower = address.split("%")[0].toLowerCase();
  const hexOnly = lower.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_match, a, b, c, d) =>
      `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`
  );
  const [head, tail] = hexOnly.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (hexOnly.includes("::") ? missing < 0 : missing !== 0) return null;
  return [...headGroups, ...new Array(Math.max(missing, 0)).fill("0"), ...tailGroups].map((group) =>
    parseInt(group, 16)
  );
}

function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * True for an address outside the public internet: loopback, private ranges,
 * link local, carrier grade NAT, multicast, reserved, and the IPv6 forms that
 * carry one of those IPv4 addresses. Anything that cannot be read counts as
 * not public.
 */
export function isNonPublicAddress(address: string): boolean {
  const version = isIP(address.split("%")[0]);
  if (version === 4) return isNonPublicIpv4(address);
  if (version !== 6) return true;

  const groups = expandIpv6(address);
  if (!groups) return true;

  const leadingZeros = (count: number) => groups.slice(0, count).every((group) => group === 0);
  // :: and ::1
  if (leadingZeros(7) && groups[7] <= 1) return true;
  // fc00::/7 unique local, fe80::/10 link local, fec0::/10 site local, ff00::/8 multicast
  if ((groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xffc0) === 0xfec0 || (groups[0] & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 documentation
  if (groups[0] === 0x2001 && groups[1] === 0xdb8) return true;
  // ::a.b.c.d and ::ffff:a.b.c.d
  if (leadingZeros(5) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return isNonPublicIpv4(ipv4FromGroups(groups[6], groups[7]));
  }
  // 64:ff9b::a.b.c.d NAT64
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    return isNonPublicIpv4(ipv4FromGroups(groups[6], groups[7]));
  }
  // 2002:a.b.c.d::/48 6to4
  if (groups[0] === 0x2002) {
    return isNonPublicIpv4(ipv4FromGroups(groups[1], groups[2]));
  }
  return false;
}

export type AddressResolver = (hostname: string) => Promise<string[]>;

async function defaultResolver(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    // Unresolvable names are left to fetch, which fails on them anyway.
    return [];
  }
}

export interface OutboundUrlOptions {
  /**
   * Refuse every address outside the public internet, and names that do not
   * resolve, for URLs nobody here chose. Without it only the metadata
   * addresses are refused, because private networks are normal destinations.
   */
  publicOnly?: boolean;
}

/**
 * Run the guard and return what it saw, so a caller that goes on to pin the
 * request connects to an address this one lookup checked. A second lookup
 * could answer differently.
 */
async function checkOutboundUrl(
  rawUrl: string,
  resolver: AddressResolver,
  { publicOnly = false }: OutboundUrlOptions
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundUrlError("Invalid URL format");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlError("Only http and https URLs are allowed");
  }

  const hostname = stripBrackets(url.hostname).toLowerCase();
  if (!hostname) {
    throw new OutboundUrlError("Invalid URL format");
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new OutboundUrlError("Requests to the instance metadata service are not allowed");
  }

  if (isIP(hostname)) {
    if (isLinkLocalAddress(hostname)) {
      throw new OutboundUrlError("Requests to link local addresses are not allowed");
    }
    if (publicOnly && isNonPublicAddress(hostname)) {
      throw new OutboundUrlError(`${hostname} is not a public address`);
    }
    return { url, addresses: [] };
  }

  const addresses = await resolver(hostname);
  if (addresses.some(isLinkLocalAddress)) {
    throw new OutboundUrlError(
      `${hostname} resolves to a link local address, which is not allowed`
    );
  }
  if (publicOnly) {
    if (addresses.length === 0) {
      throw new OutboundUrlError(`${hostname} could not be resolved`);
    }
    if (addresses.some(isNonPublicAddress)) {
      throw new OutboundUrlError(`${hostname} resolves to an address that is not public`);
    }
  }

  return { url, addresses };
}

/**
 * Parse a user supplied URL and refuse it when it points at a blocked
 * destination. Returns the parsed URL on success.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  resolver: AddressResolver = defaultResolver
): Promise<URL> {
  const { url } = await checkOutboundUrl(rawUrl, resolver, {});
  return url;
}

/**
 * For routes that store a URL for later use: the reason the URL would be
 * refused by the guard, or null when it is fine. A missing scheme is read
 * as https, matching `isValidSourceUrl`.
 */
export async function blockedOutboundUrlReason(
  raw: string,
  resolver: AddressResolver = defaultResolver
): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    await assertSafeOutboundUrl(withScheme, resolver);
    return null;
  } catch (error) {
    if (error instanceof OutboundUrlError) return error.message;
    throw error;
  }
}

export interface OutboundTarget {
  /** The URL as given, parsed and checked. */
  url: URL;
  /** The URL to actually request: pinned to the checked address for plain http. */
  requestUrl: string;
  /** Headers the request must carry (the original Host when pinned). */
  headers: Record<string, string>;
}

/**
 * Check a user supplied URL and decide where the request goes. Plain http
 * to a host name is pinned to the first address the check saw; everything
 * else is requested as given.
 */
export async function resolveOutboundTarget(
  rawUrl: string,
  resolver: AddressResolver = defaultResolver,
  options: OutboundUrlOptions = {}
): Promise<OutboundTarget> {
  const { url, addresses } = await checkOutboundUrl(rawUrl, resolver, options);
  const [address] = addresses;

  // Unresolvable names are left to fetch, which fails on them anyway.
  if (url.protocol !== "http:" || !address) {
    return { url, requestUrl: url.toString(), headers: {} };
  }

  const pinned = new URL(url.toString());
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return { url, requestUrl: pinned.toString(), headers: { Host: url.host } };
}

/** Headers that may go along when a redirect leaves the host they were meant for. */
const HEADERS_KEPT_ACROSS_HOSTS = new Set(["accept", "content-type", "user-agent"]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const MAX_OUTBOUND_REDIRECTS = 5;

function plainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers instanceof Headers || Array.isArray(headers)) {
    return Object.fromEntries(new Headers(headers).entries());
  }
  return { ...(headers as Record<string, string> | undefined) };
}

function withoutHeaders(
  headers: Record<string, string>,
  drop: (lowerCaseName: string) => boolean
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !drop(name.toLowerCase()))
  );
}

export interface GuardedFetchOptions extends OutboundUrlOptions {
  /** How many redirects to follow. At 0 a redirect comes back as the response. */
  maxRedirects?: number;
  resolver?: AddressResolver;
  /** Injected in tests; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * fetch for URLs that come from outside this process. Every hop goes through
 * the guard and, for plain http, connects to the address that hop checked. So a
 * permitted host cannot bounce the request to a blocked one, and a name cannot
 * change its answer after a URL was saved.
 *
 * Credentials stay with the host they were meant for: when a redirect moves to
 * another host, or from https down to http, only the harmless headers go along.
 * That includes custom ones such as GitLab's PRIVATE-TOKEN, which a runtime's
 * own redirect handling knows nothing about.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit = {},
  {
    maxRedirects = MAX_OUTBOUND_REDIRECTS,
    publicOnly = false,
    resolver = defaultResolver,
    fetchImpl,
  }: GuardedFetchOptions = {}
): Promise<Response> {
  // Read at call time, not import time, so tests can swap the global.
  const doFetch = fetchImpl ?? (((input, requestInit) => fetch(input, requestInit)) as typeof fetch);
  let currentUrl = rawUrl;
  let headers = plainHeaders(init.headers);
  let method = init.method;
  let body = init.body;

  for (let hop = 0; ; hop++) {
    const target = await resolveOutboundTarget(currentUrl, resolver, { publicOnly });
    const response = await doFetch(target.requestUrl, {
      ...init,
      ...(method ? { method } : {}),
      body,
      headers: { ...headers, ...target.headers },
      redirect: "manual",
    });

    if (maxRedirects === 0 || !REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (hop >= maxRedirects) {
      throw new OutboundUrlError(`Stopped after ${maxRedirects} redirects`);
    }

    let next: URL;
    try {
      next = new URL(location, target.url);
    } catch {
      throw new OutboundUrlError("The server redirected to an invalid URL");
    }
    await response.body?.cancel().catch(() => {});

    const downgraded = target.url.protocol === "https:" && next.protocol === "http:";
    if (next.host !== target.url.host || downgraded) {
      headers = withoutHeaders(headers, (name) => !HEADERS_KEPT_ACROSS_HOSTS.has(name));
    }

    // What fetch does: 303 turns into GET, and so do 301 and 302 after a POST.
    const upperMethod = (method ?? "GET").toUpperCase();
    const becomesGet =
      (response.status === 303 && upperMethod !== "GET" && upperMethod !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && upperMethod === "POST");
    if (becomesGet) {
      method = "GET";
      body = undefined;
      headers = withoutHeaders(headers, (name) => name === "content-type");
    }

    currentUrl = next.toString();
  }
}

/**
 * fetch for user supplied URLs: runs the guard first, pins plain http to
 * the checked address and never follows a redirect, so a permitted host
 * cannot bounce the request to a blocked one.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  resolver?: AddressResolver
): Promise<Response> {
  return guardedFetch(rawUrl, init, { maxRedirects: 0, resolver });
}
