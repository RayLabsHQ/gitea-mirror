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
 * metadata services this guard exists for speak no TLS at all. Callers
 * that follow redirects must run the check on every hop; `safeFetch` below
 * does not follow redirects at all.
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

/**
 * Parse a user supplied URL and refuse it when it points at a blocked
 * destination. Returns the parsed URL on success.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  resolver: AddressResolver = defaultResolver
): Promise<URL> {
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
    return url;
  }

  const addresses = await resolver(hostname);
  if (addresses.some(isLinkLocalAddress)) {
    throw new OutboundUrlError(
      `${hostname} resolves to a link local address, which is not allowed`
    );
  }

  return url;
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
  resolver: AddressResolver = defaultResolver
): Promise<OutboundTarget> {
  const url = await assertSafeOutboundUrl(rawUrl, resolver);
  const hostname = stripBrackets(url.hostname);

  if (url.protocol !== "http:" || isIP(hostname)) {
    return { url, requestUrl: url.toString(), headers: {} };
  }

  const [address] = await resolver(hostname.toLowerCase());
  if (!address || isLinkLocalAddress(address)) {
    // Unresolvable names are left to fetch, which fails on them anyway.
    return { url, requestUrl: url.toString(), headers: {} };
  }

  const pinned = new URL(url.toString());
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return { url, requestUrl: pinned.toString(), headers: { Host: url.host } };
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
  const target = await resolveOutboundTarget(rawUrl, resolver);
  let headers: HeadersInit;
  if (init.headers instanceof Headers || Array.isArray(init.headers)) {
    const merged = new Headers(init.headers);
    for (const [name, value] of Object.entries(target.headers)) merged.set(name, value);
    headers = merged;
  } else {
    headers = { ...(init.headers ?? {}), ...target.headers };
  }
  return fetch(target.requestUrl, { ...init, headers, redirect: "manual" });
}
