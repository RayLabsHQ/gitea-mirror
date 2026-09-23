import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, RefreshCw, Building2, Check, AlertCircle, Clock, Ban, Layers } from "lucide-react";
import type { MirrorOverrides, Organization } from "@/lib/db/schema";
import type { FilterParams } from "@/types/filter";
import type { SourceApiRecord } from "@/types/config";
import Fuse from "fuse.js";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { buildGiteaWebUrl } from "@/lib/gitea-url";
import { MirrorDestinationEditor } from "./MirrorDestinationEditor";
import { DestinationIcon, destinationInfo } from "@/components/destination/DestinationIcon";
import type { OrganizationMoveResult } from "@/lib/destination-transfer";
import { MirrorOverridesDialog } from "@/components/config/MirrorOverridesDialog";
import { hasMirrorOverrides, mirrorOptionsToFlags } from "@/lib/utils/mirror-overrides";
import { useGiteaConfig } from "@/hooks/useGiteaConfig";
import { getCachedConfig } from "@/hooks/useConfigStatus";
import { withBase } from "@/lib/base-path";
import {
  SOURCE_PROVIDER_LABELS,
  SOURCE_PROVIDER_ORG_NOUNS,
  normalizeSourceUrl,
  type SourceProviderKind,
} from "@/lib/source-providers/kinds";
import { SOURCE_PROVIDER_ICONS } from "@/lib/source-providers/icons";
import type { OrganizationsViewMode } from "@/lib/utils/organizations-view";
import { OrganizationSourceEditor } from "./OrganizationSourceEditor";
import { OrganizationActionsMenu } from "./OrganizationActionsMenu";
import { OrganizationsTable } from "./OrganizationsTable";
import { getOrganizationStatusBadge, resolveOrganizationSource } from "./organization-presentation";

interface OrganizationListProps {
  organizations: Organization[];
  isLoading: boolean;
  filter: FilterParams;
  setFilter: (filter: FilterParams) => void;
  onMirror: ({ orgId }: { orgId: string }) => Promise<void>;
  /**
   * Re-sync an organization that has already been mirrored. The Mirror
   * button only covers the first run, so without this an organization could
   * never be refreshed by hand (#429).
   */
  onSync?: ({ orgId }: { orgId: string }) => Promise<void>;
  onIgnore?: ({ orgId, ignore }: { orgId: string; ignore: boolean }) => Promise<void>;
  loadingOrgIds: Set<string>;
  onAddOrganization?: () => void;
  onRefresh?: () => Promise<void>;
  onDelete?: (orgId: string) => void;
  sourceProvider?: SourceProviderKind;
  /** Normalized instance URL of the configured source; falls back to the cached config. */
  sourceUrl?: string;
  /** Connected sources; with more than one, each card shows and edits its own source. */
  sources?: SourceApiRecord[];
  /** Cards (default) or the compact list (#428). */
  view?: OrganizationsViewMode;
}

const STATUS_ICONS = { check: Check, alert: AlertCircle, clock: Clock, ban: Ban } as const;

// Helper function to get status badge variant and icon
const getStatusBadge = (status: string | null) => {
  const badge = getOrganizationStatusBadge(status);
  return { ...badge, icon: badge.icon ? STATUS_ICONS[badge.icon] : null };
};

export function OrganizationList({
  organizations,
  isLoading,
  filter,
  setFilter,
  onMirror,
  onSync,
  onIgnore,
  loadingOrgIds,
  onAddOrganization,
  onRefresh,
  onDelete,
  sourceProvider = "github",
  sourceUrl: sourceUrlProp,
  sources,
  view = "cards",
}: OrganizationListProps) {
  const { giteaConfig, mirrorOptions, advancedOptions } = useGiteaConfig();
  const [overridesTarget, setOverridesTarget] = useState<Organization | null>(null);

  const hasMultipleSources = !!sources && sources.length > 1;
  const sourceUrl =
    sourceUrlProp ??
    normalizeSourceUrl(getCachedConfig()?.githubConfig?.url, sourceProvider);

  const handleUpdateMirrorOverrides = async (
    orgId: string,
    overrides: MirrorOverrides | null
  ) => {
    const response = await fetch(`${withBase("/api/organizations")}/${orgId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mirrorOverrides: overrides }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to update mirror options");
    }

    if (onRefresh) {
      await onRefresh();
    }
  };

  // Helper function to construct Gitea organization URL
  const getGiteaOrgUrl = (organization: Organization): string | null => {
    // Only provide Gitea links for organizations that have been mirrored
    const validStatuses = ['mirroring', 'mirrored'];
    if (!validStatuses.includes(organization.status || '')) {
      return null;
    }

    // Use destinationOrg if available, otherwise use the organization name
    const orgName = organization.destinationOrg || organization.name;
    if (!orgName) {
      return null;
    }

    return buildGiteaWebUrl(giteaConfig, orgName);
  };

  const handleUpdateDestination = async (orgId: string, newDestination: string | null) => {
    // Call API to update organization destination
    const response = await fetch(`${withBase("/api/organizations")}/${orgId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationOrg: newDestination,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to update organization");
    }

    // Refresh organizations data
    if (onRefresh) {
      await onRefresh();
    }
  };

  // Pin an organization to one source, or clear the pin with null (the org
  // then follows every connected source).
  const handleUpdateSource = async (orgId: string, sourceId: string | null) => {
    const response = await fetch(`${withBase("/api/organizations")}/${orgId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sourceId }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to update organization");
    }

    if (onRefresh) {
      await onRefresh();
    }
  };

  // Plan (dryRun) or perform the move of an organization's mirrors on the
  // destination when its destination changes (issue #400).
  const handleMoveMirrors = async (
    orgId: string,
    newDestination: string | null,
    dryRun: boolean
  ): Promise<OrganizationMoveResult> => {
    const response = await fetch(`${withBase("/api/organizations")}/${orgId}/move-mirrors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationOrg: newDestination, dryRun }),
    });
    const data = (await response.json().catch(() => ({}))) as Partial<OrganizationMoveResult> & {
      success?: boolean;
      error?: string;
    };
    if (!response.ok || !data.success || !data.plan) {
      throw new Error(data.error || "Failed to move the mirrors");
    }
    if (!dryRun && onRefresh) {
      await onRefresh();
    }
    return data as OrganizationMoveResult;
  };

  // GitHub and GitLab destinations are pushed to; only Gitea and Forgejo can transfer a repository.
  const destination = destinationInfo(giteaConfig);

  // Tooltip for the destination link on a card. Named after the configured
  // destination, so a Forgejo user is not told to view the org on Gitea (#430).
  const destinationLinkTooltip = (org: Organization, orgUrl: string | null): string => {
    if (!giteaConfig?.url) return `${destination.label} not configured`;
    if (org.status === "imported") return `Organization not yet mirrored to ${destination.label}`;
    if (org.status === "failed") return "Organization mirroring failed";
    if (org.status === "mirroring") return `Organization is being mirrored to ${destination.label}`;
    if (orgUrl) return `View on ${destination.label}`;
    return `${destination.label} organization not available`;
  };

  // Where an organization's repositories land with no override, which is what
  // the mirror strategy produces for organization repositories (see
  // getGiteaRepoOwner in src/lib/gitea.ts). Only "preserve" and "mixed" make
  // that the organization's own name, so the editor cannot assume it (#416).
  // preserveOrgStructure is not consulted: the config API maps it from
  // preserveVisibility, so mirrorStrategy is the only reliable signal here.
  const defaultDestinationFor = (orgName: string): string => {
    const strategy = giteaConfig?.mirrorStrategy || "preserve";
    if (strategy === "single-org") {
      return giteaConfig?.organization || giteaConfig?.username || orgName;
    }
    if (strategy === "flat-user") {
      return giteaConfig?.username || orgName;
    }
    return orgName;
  };

  const hasAnyFilter = Object.values(filter).some(
    (val) => val?.toString().trim() !== ""
  );

  const filteredOrganizations = useMemo(() => {
    let result = organizations;

    if (filter.membershipRole) {
      result = result.filter((org) => org.membershipRole === filter.membershipRole);
    }

    if (filter.status) {
      result = result.filter((org) => org.status === filter.status);
    }

    if (filter.hasOverrides) {
      const wantOverridden = filter.hasOverrides === "overridden";
      result = result.filter(
        (org) => hasMirrorOverrides(org.mirrorOverrides) === wantOverridden
      );
    }

    if (filter.searchTerm) {
      const fuse = new Fuse(result, {
        keys: ["name", "type"],
        threshold: 0.3,
      });
      result = fuse.search(filter.searchTerm).map((res) => res.item);
    }

    return result;
  }, [organizations, filter]);

  const overridesDialog = (
    <MirrorOverridesDialog
      open={!!overridesTarget}
      onOpenChange={(open) => {
        if (!open) setOverridesTarget(null);
      }}
      targetKind="organization"
      targetName={overridesTarget?.name ?? ""}
      value={overridesTarget?.mirrorOverrides ?? null}
      destinationProvider={giteaConfig?.provider}
      inheritedFrom={{
        ...mirrorOptionsToFlags(mirrorOptions),
        skipForks: !!advancedOptions?.skipForks,
      }}
      inheritedLabel="global settings"
      onSave={async (overrides) => {
        if (overridesTarget?.id) {
          await handleUpdateMirrorOverrides(overridesTarget.id, overrides);
        }
      }}
    />
  );

  return isLoading ? (
    view === "list" ? (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    ) : (
      <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(27rem,1fr))] gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[11.25rem] w-full" />
        ))}
      </div>
    )
  ) : filteredOrganizations.length === 0 ? (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
      <h3 className="text-lg font-medium">No organizations found</h3>
      <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md">
        {hasAnyFilter
          ? "Try adjusting your search or filter criteria."
          : `Add ${SOURCE_PROVIDER_LABELS[sourceProvider]} ${SOURCE_PROVIDER_ORG_NOUNS[sourceProvider]}s to mirror their repositories.`}
      </p>
      {hasAnyFilter ? (
        <Button
          variant="outline"
          onClick={() => {
            setFilter({
              searchTerm: "",
              membershipRole: "",
            });
          }}
        >
          Clear Filters
        </Button>
      ) : (
        <Button onClick={onAddOrganization}>
          <Plus className="h-4 w-4 mr-2" />
          Add Organization
        </Button>
      )}
    </div>
  ) : view === "list" ? (
    <>
      <OrganizationsTable
        organizations={filteredOrganizations}
        loadingOrgIds={loadingOrgIds}
        sources={sources}
        sourceProvider={sourceProvider}
        sourceUrl={sourceUrl}
        destination={destination}
        getDestinationUrl={getGiteaOrgUrl}
        destinationLinkTooltip={destinationLinkTooltip}
        defaultDestinationFor={defaultDestinationFor}
        onUpdateDestination={handleUpdateDestination}
        onMoveMirrors={destination.isPushTarget ? undefined : handleMoveMirrors}
        onUpdateSource={handleUpdateSource}
        onMirror={onMirror}
        onSync={onSync}
        onIgnore={onIgnore}
        onDelete={onDelete}
        onEditMirrorOptions={setOverridesTarget}
      />
      {overridesDialog}
    </>
  ) : (
    <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(27rem,1fr))] gap-4 pb-20 sm:pb-0">
      {filteredOrganizations.map((org, index) => {
        const isLoading = loadingOrgIds.has(org.id ?? "");
        const statusBadge = getStatusBadge(org.status);
        const StatusIcon = statusBadge.icon;
        const orgSources = sources ?? [];
        const orgSource = resolveOrganizationSource(org, sources, sourceProvider, sourceUrl);
        const { pinnedSource, isPublicOnlySource } = orgSource;
        const orgSourceUrl = orgSource.sourceUrl;
        const orgSourceLabel = orgSource.label;
        const orgSourceShortLabel = orgSource.shortLabel;
        const OrgSourceIcon = SOURCE_PROVIDER_ICONS[orgSource.provider];

        return (
          <Card 
            key={index} 
            className={cn(
              "overflow-hidden p-4 sm:p-6 transition-all hover:shadow-lg hover:border-foreground/10 w-full",
              isLoading && "opacity-75"
            )}
          >
            {/* Mobile Layout */}
            <div className="flex flex-col gap-3 sm:hidden">
              {/* Header with org name and badges */}
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <a 
                      href={`${withBase('/repositories')}?organization=${encodeURIComponent(org.name || '')}`}
                      className="font-medium hover:underline cursor-pointer truncate"
                    >
                      {org.name}
                    </a>
                  </div>
                  <Badge variant={statusBadge.variant} className="flex-shrink-0">
                    {StatusIcon && <StatusIcon className={cn(
                      "h-3 w-3",
                      org.status === "mirroring" && "animate-pulse"
                    )} />}
                    {statusBadge.label}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                        org.membershipRole === "member"
                          ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                          : "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
                      }`}
                    >
                      {org.membershipRole}
                    </span>
                    {hasMultipleSources && (
                      <Badge
                        variant="outline"
                        className="gap-1 px-1.5 font-normal text-[11px]"
                        title={`Source: ${pinnedSource?.name ?? "Every source"}`}
                      >
                        {pinnedSource ? <OrgSourceIcon className="h-3 w-3" /> : <Layers className="h-3 w-3" />}
                        {pinnedSource?.name ?? "Every source"}
                      </Badge>
                    )}
                    {isPublicOnlySource && (
                      <Badge
                        variant="secondary"
                        className="px-1.5 font-normal text-[11px]"
                        title="Mirrors public repositories only; its source has no account"
                      >
                        Public only
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-semibold">{org.repositoryCount}</span>
                    <span className="ml-1">repos</span>
                    {/* Repository breakdown for mobile - only show non-zero counts */}
                    {(() => {
                      const parts = [];
                      if (org.publicRepositoryCount && org.publicRepositoryCount > 0) {
                        parts.push(`${org.publicRepositoryCount} pub`);
                      }
                      if (org.privateRepositoryCount && org.privateRepositoryCount > 0) {
                        parts.push(`${org.privateRepositoryCount} priv`);
                      }
                      if (org.forkRepositoryCount && org.forkRepositoryCount > 0) {
                        parts.push(`${org.forkRepositoryCount} fork`);
                      }
                      
                      return parts.length > 0 ? (
                        <span className="ml-1">({parts.join(' | ')})</span>
                      ) : null;
                    })()}
                  </div>
                </div>
              </div>

              {/* Error message for failed orgs */}
              {org.status === "failed" && org.errorMessage && (
                <p className="text-xs text-destructive line-clamp-2">{org.errorMessage}</p>
              )}

              {/* Destination override section */}
              <div>
                <MirrorDestinationEditor
                  organizationId={org.id!}
                  organizationName={org.name!}
                  currentDestination={org.destinationOrg ?? undefined}
                  defaultDestination={defaultDestinationFor(org.name!)}
                  onUpdate={(newDestination) => handleUpdateDestination(org.id!, newDestination)}
                  onMoveMirrors={
                    destination.isPushTarget
                      ? undefined
                      : (newDestination, dryRun) => handleMoveMirrors(org.id!, newDestination, dryRun)
                  }
                  destinationLabel={destination.label}
                  isUpdating={isLoading}
                />
              </div>

              {/* Source picker (multi-source only) */}
              {hasMultipleSources && (
                <div>
                  <OrganizationSourceEditor
                    sources={orgSources}
                    value={pinnedSource?.id ?? null}
                    disabled={isLoading}
                    onUpdateSource={(newSourceId) => handleUpdateSource(org.id!, newSourceId)}
                  />
                </div>
              )}
            </div>

            {/* Desktop Layout */}
            <div className="hidden sm:block">
              {/* Header with org icon, name, role badge and status */}
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <a 
                        href={`${withBase('/repositories')}?organization=${encodeURIComponent(org.name || '')}`}
                        className="text-xl font-semibold hover:underline cursor-pointer"
                      >
                        {org.name}
                      </a>
                      <Badge 
                        variant={org.membershipRole === "member" ? "secondary" : "default"}
                        className="capitalize"
                      >
                        {org.membershipRole}
                      </Badge>
                    </div>
                  </div>
                </div>
                
                {/* Status badge */}
                <div className="flex items-center gap-2">
                  {hasMultipleSources && (
                    <Badge
                      variant="outline"
                      className="gap-1 px-1.5 font-normal text-[11px]"
                      title={`Source: ${pinnedSource?.name ?? "Every source"}`}
                    >
                      {pinnedSource ? <OrgSourceIcon className="h-3 w-3" /> : <Layers className="h-3 w-3" />}
                      {pinnedSource?.name ?? "Every source"}
                    </Badge>
                  )}
                  {isPublicOnlySource && (
                    <Badge
                      variant="secondary"
                      className="px-1.5 font-normal text-[11px]"
                      title="Mirrors public repositories only; its source has no account"
                    >
                      Public only
                    </Badge>
                  )}
                  {hasMirrorOverrides(org.mirrorOverrides) && (
                    <Badge
                      variant="outline"
                      className="text-amber-600 dark:text-amber-400 border-amber-500/40"
                      title="This organization overrides the global mirror options"
                    >
                      Custom options
                    </Badge>
                  )}
                  <Badge variant={statusBadge.variant} className="flex items-center gap-1">
                    {StatusIcon && <StatusIcon className={cn(
                      "h-3.5 w-3.5",
                      org.status === "mirroring" && "animate-pulse"
                    )} />}
                    {statusBadge.label}
                  </Badge>
                </div>
              </div>

              {/* Destination override section */}
              <div className="mb-4">
                <MirrorDestinationEditor
                  organizationId={org.id!}
                  organizationName={org.name!}
                  currentDestination={org.destinationOrg ?? undefined}
                  defaultDestination={defaultDestinationFor(org.name!)}
                  onUpdate={(newDestination) => handleUpdateDestination(org.id!, newDestination)}
                  onMoveMirrors={
                    destination.isPushTarget
                      ? undefined
                      : (newDestination, dryRun) => handleMoveMirrors(org.id!, newDestination, dryRun)
                  }
                  destinationLabel={destination.label}
                  isUpdating={isLoading}
                />
              </div>

              {/* Source picker (multi-source only) */}
              {hasMultipleSources && (
                <div className="mb-4">
                  <OrganizationSourceEditor
                    sources={orgSources}
                    value={pinnedSource?.id ?? null}
                    disabled={isLoading}
                    onUpdateSource={(newSourceId) => handleUpdateSource(org.id!, newSourceId)}
                  />
                </div>
              )}

              {/* Error message for failed orgs */}
              {org.status === "failed" && org.errorMessage && (
                <div className="mb-4 p-3 rounded-md bg-destructive/10 border border-destructive/20">
                  <p className="text-sm text-destructive">{org.errorMessage}</p>
                </div>
              )}

              {/* Repository statistics */}
              <div className="mb-4">
                <div className="flex items-center gap-4 text-sm">
                  <div>
                    <span className="font-semibold text-lg">{org.repositoryCount}</span>
                    <span className="text-muted-foreground ml-1">
                      {org.repositoryCount === 1 ? "repository" : "repositories"}
                    </span>
                  </div>

                  {/* Repository breakdown - only show non-zero counts */}
                  {(() => {
                    const counts = [];
                    if (org.publicRepositoryCount && org.publicRepositoryCount > 0) {
                      counts.push(`${org.publicRepositoryCount} public`);
                    }
                    if (org.privateRepositoryCount && org.privateRepositoryCount > 0) {
                      counts.push(`${org.privateRepositoryCount} private`);
                    }
                    if (org.forkRepositoryCount && org.forkRepositoryCount > 0) {
                      counts.push(`${org.forkRepositoryCount} ${org.forkRepositoryCount === 1 ? 'fork' : 'forks'}`);
                    }

                    return counts.length > 0 ? (
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {counts.map((count, index) => (
                          <span key={index} className={index > 0 ? "border-l pl-3" : ""}>
                            {count}
                          </span>
                        ))}
                      </div>
                    ) : null;
                  })()}
                </div>
              </div>
            </div>

            {/* Mobile Actions */}
            <div className="flex flex-col gap-3 sm:hidden">
              <div className="flex items-center gap-2">
                {org.status === "ignored" ? (
                  <Button
                    size="default"
                    variant="outline"
                    onClick={() => org.id && onIgnore && onIgnore({ orgId: org.id, ignore: false })}
                    disabled={isLoading}
                    className="w-full h-10"
                  >
                    <Check className="h-4 w-4 mr-2" />
                    Include Organization
                  </Button>
                ) : (
                  <>
                    {org.status === "imported" && (
                      <Button
                        size="default"
                        onClick={() => org.id && onMirror({ orgId: org.id })}
                        disabled={isLoading}
                        className="w-full h-10"
                      >
                        {isLoading ? (
                          <>
                            <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                            Starting...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Mirror Organization
                          </>
                        )}
                      </Button>
                    )}
                    
                    {org.status === "mirroring" && (
                      <Button size="default" disabled variant="outline" className="w-full h-10">
                        <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                        Mirroring...
                      </Button>
                    )}
                    
                    {org.status === "mirrored" && (
                      <Button size="default" disabled variant="secondary" className="w-full h-10">
                        <Check className="h-4 w-4 mr-2" />
                        Mirrored
                      </Button>
                    )}
                    
                    {org.status === "failed" && (
                      <Button
                        size="default"
                        variant="destructive"
                        onClick={() => org.id && onMirror({ orgId: org.id })}
                        disabled={isLoading}
                        className="w-full h-10"
                      >
                        {isLoading ? (
                          <>
                            <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                            Retrying...
                          </>
                        ) : (
                          <>
                            <AlertCircle className="h-4 w-4 mr-2" />
                            Retry Mirror
                          </>
                        )}
                      </Button>
                    )}
                  </>
                )}

                <OrganizationActionsMenu
                  org={org}
                  disabled={isLoading}
                  onSync={onSync}
                  onIgnore={onIgnore}
                  onDelete={onDelete}
                  onEditMirrorOptions={setOverridesTarget}
                  triggerClassName="h-10 w-10"
                />
              </div>

              <div className="flex items-center gap-2 justify-center">
                {(() => {
                  const giteaUrl = getGiteaOrgUrl(org);

                  const tooltip = destinationLinkTooltip(org, giteaUrl);

                  return giteaUrl ? (
                    <Button variant="outline" size="default" asChild className="flex-1 h-10 min-w-0">
                      <a
                        href={giteaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={tooltip}
                        className="flex items-center justify-center gap-2"
                      >
                        <DestinationIcon provider={destination.provider} className="h-4 w-4 flex-shrink-0" />
                        <span className="text-xs">{destination.label}</span>
                      </a>
                    </Button>
                  ) : (
                    <Button variant="outline" size="default" disabled title={tooltip} className="flex-1 h-10">
                      <DestinationIcon provider={destination.provider} className="h-4 w-4" />
                      <span className="text-xs ml-2">{destination.label}</span>
                    </Button>
                  );
                })()}
                <Button variant="outline" size="default" asChild className="flex-1 h-10 min-w-0">
                  <a
                    href={`${orgSourceUrl}/${org.name}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`View on ${orgSourceLabel}`}
                    className="flex items-center justify-center gap-2"
                  >
                    <OrgSourceIcon className="h-4 w-4 flex-shrink-0" />
                    <span className="text-xs">{orgSourceShortLabel}</span>
                  </a>
                </Button>
              </div>
            </div>
            
            {/* Desktop Actions */}
            <div className="hidden sm:flex items-center justify-between mt-4">
              <div className="flex items-center gap-2">
                {org.status === "ignored" ? (
                  <Button
                    size="default"
                    variant="outline"
                    onClick={() => org.id && onIgnore && onIgnore({ orgId: org.id, ignore: false })}
                    disabled={isLoading}
                  >
                    <Check className="h-4 w-4 mr-2" />
                    Include Organization
                  </Button>
                ) : (
                  <>
                    {org.status === "imported" && (
                      <Button
                        size="default"
                        onClick={() => org.id && onMirror({ orgId: org.id })}
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <>
                            <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                            Starting mirror...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Mirror Organization
                          </>
                        )}
                      </Button>
                    )}
                    
                    {org.status === "mirroring" && (
                      <Button size="default" disabled variant="outline">
                        <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                        Mirroring in progress...
                      </Button>
                    )}
                    
                    {org.status === "mirrored" && (
                      <Button size="default" disabled variant="secondary">
                        <Check className="h-4 w-4 mr-2" />
                        Successfully mirrored
                      </Button>
                    )}
                    
                    {org.status === "failed" && (
                      <Button
                        size="default"
                        variant="destructive"
                        onClick={() => org.id && onMirror({ orgId: org.id })}
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <>
                            <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                            Retrying...
                          </>
                        ) : (
                          <>
                            <AlertCircle className="h-4 w-4 mr-2" />
                            Retry Mirror
                          </>
                        )}
                      </Button>
                    )}
                  </>
                )}
                
                <OrganizationActionsMenu
                  org={org}
                  disabled={isLoading}
                  onSync={onSync}
                  onIgnore={onIgnore}
                  onDelete={onDelete}
                  onEditMirrorOptions={setOverridesTarget}
                />
              </div>

              <div className="flex items-center gap-2">
                {(() => {
                  const giteaUrl = getGiteaOrgUrl(org);

                  const tooltip = destinationLinkTooltip(org, giteaUrl);

                  return (
                    <div className="flex items-center border rounded-md">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        asChild={!!giteaUrl}
                        disabled={!giteaUrl} 
                        title={tooltip}
                        className="rounded-none rounded-l-md border-r"
                      >
                        {giteaUrl ? (
                          <a
                            href={giteaUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <DestinationIcon provider={destination.provider} className="h-4 w-4 mr-2" />
                            {destination.label}
                          </a>
                        ) : (
                          <>
                            <DestinationIcon provider={destination.provider} className="h-4 w-4 mr-2" />
                            {destination.label}
                          </>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        asChild
                        className="rounded-none rounded-r-md"
                      >
                        <a
                          href={`${orgSourceUrl}/${org.name}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`View on ${orgSourceLabel}`}
                        >
                          <OrgSourceIcon className="h-4 w-4 mr-2" />
                          {orgSourceShortLabel}
                        </a>
                      </Button>
                    </div>
                  );
                })()}
              </div>
            </div>
          </Card>
        );
      })}

      {overridesDialog}
    </div>
  );
}
