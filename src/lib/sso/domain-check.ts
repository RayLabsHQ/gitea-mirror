/**
 * The Domain field of an SSO provider is the email domain of its users
 * (example.com), not the provider's own hostname (auth.example.com).
 * Discover used to fill it with the issuer's hostname, and nobody has an
 * email address there, so with that value new SSO accounts and first time
 * account links are refused.
 */

function hostnameOf(issuer: string | null | undefined): string | null {
  if (typeof issuer !== "string" || issuer.trim() === "") return null;
  try {
    const host = new URL(issuer.trim()).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * True when one of the entries in the Domain field is the issuer's hostname,
 * which is almost always a mistake. Entries are comma separated.
 */
export function domainIsIssuerHost(
  domain: string | null | undefined,
  issuer: string | null | undefined,
): boolean {
  const host = hostnameOf(issuer);
  if (!host || typeof domain !== "string") return false;
  return domain
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^www\./, ""))
    .some((entry) => entry === host);
}

export const ISSUER_HOST_DOMAIN_WARNING =
  "This is the provider's hostname. Use your users' email domain instead, such as example.com. Until then, new users can't sign up through SSO and existing accounts can't link to it.";
