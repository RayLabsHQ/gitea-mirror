/** Redirect URL rules for OAuth applications Gitea Mirror issues identities to. */

export type ApplicationType = "web" | "native";

/** The type the plugin checks redirect URLs for; rows from 1.6 keep it in `type`. */
export function applicationTypeOf(row: { applicationType?: string | null; type?: string | null }): ApplicationType {
  return (row.applicationType ?? row.type) === "native" ? "native" : "web";
}

// The OAuth provider plugin's redirect URL rules in better-auth 1.7
// (validateClientRedirectUri), in plain words. Creating an application runs
// them here first for a clear message, and the plugin checks again; changes
// are written here without the plugin, so these are the only check.
//
// - web: https, and not this machine (no localhost, 127.x or [::1]).
// - native: https on a real host, http only on exactly localhost, 127.0.0.1
//   or [::1], or an app scheme named like a reverse domain
//   (com.example.app:/callback).
const NATIVE_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REFUSED_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "ftp:", "mailto:"]);
const REVERSE_DOMAIN_SCHEME = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

// Exactly what the plugin counts as this machine: localhost, 127.0.0.0/8 and
// [::1]. It does not count *.localhost names.
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function redirectUriProblem(value: string, applicationType: ApplicationType = "web"): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${value} is not a valid URL`;
  }
  if (value.includes("#") || url.username || url.password) {
    return `${value} must not contain a fragment (#) or a user name and password`;
  }
  if (REFUSED_SCHEMES.has(url.protocol)) return `${value} cannot use the ${url.protocol} scheme`;

  const isHttp = url.protocol === "http:";
  const isHttps = url.protocol === "https:";
  if (applicationType === "web") {
    if ((isHttp || isHttps) && isLoopback(url.hostname)) {
      return `${value} points at this machine, which web applications cannot use. Send type "native" for an app that runs on this machine`;
    }
    if (!isHttps) return `${value} must use https: web applications need an https redirect URL`;
    return null;
  }
  if (isHttps) {
    return isLoopback(url.hostname)
      ? `${value}: a native application uses http, not https, for localhost`
      : null;
  }
  if (isHttp) {
    return NATIVE_HTTP_HOSTS.has(url.hostname.toLowerCase())
      ? null
      : `${value}: a native application can use http only for localhost, 127.0.0.1 or [::1]`;
  }
  const rest = value.slice(url.protocol.length);
  const scheme = url.protocol.slice(0, -1);
  if (url.host || !rest.startsWith("/") || rest.startsWith("//") || !REVERSE_DOMAIN_SCHEME.test(scheme)) {
    return `${value}: an app scheme must be a reverse domain name followed by a path, such as com.example.app:/callback`;
  }
  return null;
}
