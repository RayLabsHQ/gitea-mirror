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
 * a DNS name pointing at the metadata range is refused too. Callers that
 * follow redirects must run the check on every hop; `safeFetch` below does
 * not follow redirects at all.
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

/**
 * fetch for user supplied URLs: runs the guard first and never follows a
 * redirect, so a permitted host cannot bounce the request to a blocked one.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  resolver?: AddressResolver
): Promise<Response> {
  const url = await assertSafeOutboundUrl(rawUrl, resolver);
  return fetch(url.toString(), { ...init, redirect: "manual" });
}
