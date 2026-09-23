import type { Organization } from "@/lib/db/schema";
import type { SourceApiRecord } from "@/types/config";
import {
  SOURCE_PROVIDER_LABELS,
  normalizeSourceUrl,
  type SourceProviderKind,
} from "@/lib/source-providers/kinds";

export interface OrganizationSourceInfo {
  /** The source this organization is pinned to, if any. */
  pinnedSource: SourceApiRecord | null;
  /** A pinned source with no account mirrors public repositories only. */
  isPublicOnlySource: boolean;
  provider: SourceProviderKind;
  /** Normalized instance URL of the source the organization lives on. */
  sourceUrl: string;
  /** Full provider label, for tooltips. */
  label: string;
  /** Shorter label for buttons: Gitea and Forgejo sources both read "Gitea". */
  shortLabel: string;
}

/**
 * Which source an organization belongs to, for the cards and the list.
 * Unpinned organizations follow the configured (or first) source.
 */
export function resolveOrganizationSource(
  org: Pick<Organization, "sourceId">,
  sources: SourceApiRecord[] | undefined,
  fallbackProvider: SourceProviderKind,
  fallbackUrl: string
): OrganizationSourceInfo {
  const pinnedSource = (sources ?? []).find((source) => source.id === org.sourceId) ?? null;
  const provider: SourceProviderKind = pinnedSource?.provider ?? fallbackProvider;
  const label = SOURCE_PROVIDER_LABELS[provider];
  return {
    pinnedSource,
    isPublicOnlySource: pinnedSource?.token === "",
    provider,
    sourceUrl: pinnedSource
      ? normalizeSourceUrl(pinnedSource.url, pinnedSource.provider)
      : fallbackUrl,
    label,
    shortLabel: provider === "gitea" ? "Gitea" : label,
  };
}

export type OrganizationStatusBadge = {
  variant: "default" | "secondary" | "outline" | "destructive";
  label: string;
  icon: "check" | "alert" | "clock" | "ban" | null;
};

/** Badge variant, label and icon for an organization status. */
export function getOrganizationStatusBadge(status: string | null | undefined): OrganizationStatusBadge {
  switch (status) {
    case "imported":
      return { variant: "secondary", label: "Not Mirrored", icon: null };
    case "mirroring":
      return { variant: "outline", label: "Mirroring", icon: "clock" };
    case "mirrored":
      return { variant: "default", label: "Mirrored", icon: "check" };
    case "failed":
      return { variant: "destructive", label: "Failed", icon: "alert" };
    case "ignored":
      return { variant: "outline", label: "Ignored", icon: "ban" };
    default:
      return { variant: "secondary", label: "Unknown", icon: null };
  }
}

/** "3 public | 2 private | 1 fork" style breakdown, only the non-zero parts. */
export function describeRepositoryBreakdown(
  org: Pick<Organization, "publicRepositoryCount" | "privateRepositoryCount" | "forkRepositoryCount">,
  style: "long" | "short" = "long"
): string[] {
  const parts: string[] = [];
  const pub = org.publicRepositoryCount ?? 0;
  const priv = org.privateRepositoryCount ?? 0;
  const forks = org.forkRepositoryCount ?? 0;
  if (pub > 0) parts.push(style === "long" ? `${pub} public` : `${pub} pub`);
  if (priv > 0) parts.push(style === "long" ? `${priv} private` : `${priv} priv`);
  if (forks > 0) {
    parts.push(
      style === "long" ? `${forks} ${forks === 1 ? "fork" : "forks"}` : `${forks} fork`
    );
  }
  return parts;
}
