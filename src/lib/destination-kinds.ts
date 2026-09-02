/**
 * The hosts Gitea Mirror can mirror into. Gitea and Forgejo share the same
 * API, so this only changes labels and hints; kept free of imports so client
 * components can use it.
 */
export const DESTINATION_PROVIDER_KINDS = ["gitea", "forgejo"] as const;

export type DestinationProviderKind = (typeof DESTINATION_PROVIDER_KINDS)[number];

export const DEFAULT_DESTINATION_PROVIDER: DestinationProviderKind = "gitea";

export const DESTINATION_PROVIDER_LABELS: Record<DestinationProviderKind, string> = {
  gitea: "Gitea",
  forgejo: "Forgejo",
};

export function isDestinationProviderKind(value: unknown): value is DestinationProviderKind {
  return (
    typeof value === "string" &&
    (DESTINATION_PROVIDER_KINDS as readonly string[]).includes(value)
  );
}

/** Coerce an untrusted value to a destination kind, defaulting to Gitea. Codeberg is Forgejo. */
export function normalizeDestinationProviderKind(value: unknown): DestinationProviderKind {
  if (isDestinationProviderKind(value)) return value;
  if (value === "codeberg") return "forgejo";
  return DEFAULT_DESTINATION_PROVIDER;
}
