import { AlertCircle, Ban, Check, Clock, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Organization } from "@/lib/db/schema";
import type { SourceApiRecord } from "@/types/config";
import type { OrganizationMoveResult } from "@/lib/destination-transfer";
import type { SourceProviderKind } from "@/lib/source-providers/kinds";
import { SOURCE_PROVIDER_ICONS } from "@/lib/source-providers/icons";
import { DestinationIcon, type destinationInfo } from "@/components/destination/DestinationIcon";
import { cn, formatLastSyncTime } from "@/lib/utils";
import { hasMirrorOverrides } from "@/lib/utils/mirror-overrides";
import { withBase } from "@/lib/base-path";
import { MirrorDestinationEditor } from "./MirrorDestinationEditor";
import { OrganizationSourceEditor } from "./OrganizationSourceEditor";
import { OrganizationActionsMenu } from "./OrganizationActionsMenu";
import {
  describeRepositoryBreakdown,
  getOrganizationStatusBadge,
  resolveOrganizationSource,
} from "./organization-presentation";

const STATUS_ICONS = {
  check: Check,
  alert: AlertCircle,
  clock: Clock,
  ban: Ban,
} as const;

export interface OrganizationsTableProps {
  organizations: Organization[];
  loadingOrgIds: Set<string>;
  sources?: SourceApiRecord[];
  sourceProvider: SourceProviderKind;
  sourceUrl: string;
  destination: ReturnType<typeof destinationInfo>;
  getDestinationUrl: (org: Organization) => string | null;
  destinationLinkTooltip: (org: Organization, url: string | null) => string;
  defaultDestinationFor: (orgName: string) => string;
  onUpdateDestination: (orgId: string, destination: string | null) => Promise<void>;
  onMoveMirrors?: (
    orgId: string,
    destination: string | null,
    dryRun: boolean
  ) => Promise<OrganizationMoveResult>;
  onUpdateSource: (orgId: string, sourceId: string | null) => Promise<void>;
  onMirror: ({ orgId }: { orgId: string }) => Promise<void>;
  onSync?: ({ orgId }: { orgId: string }) => Promise<void>;
  onIgnore?: ({ orgId, ignore }: { orgId: string; ignore: boolean }) => Promise<void>;
  onDelete?: (orgId: string) => void;
  onEditMirrorOptions: (org: Organization) => void;
}

/**
 * The compact list view of the Organizations page (#428): one row per
 * organization so a few dozen fit on one screen. Same actions as the cards,
 * with the secondary ones behind the menu.
 */
export function OrganizationsTable({
  organizations,
  loadingOrgIds,
  sources,
  sourceProvider,
  sourceUrl,
  destination,
  getDestinationUrl,
  destinationLinkTooltip,
  defaultDestinationFor,
  onUpdateDestination,
  onMoveMirrors,
  onUpdateSource,
  onMirror,
  onSync,
  onIgnore,
  onDelete,
  onEditMirrorOptions,
}: OrganizationsTableProps) {
  const hasMultipleSources = !!sources && sources.length > 1;

  return (
    <div className="overflow-x-auto pb-20 sm:pb-0" data-testid="organizations-table">
      <div className="min-w-[64rem] border rounded-md">
        {/* Header */}
        <div className="h-[45px] flex items-center border-b bg-muted/50 text-sm font-medium">
          <div className="h-full p-3 flex items-center flex-[2.2] sticky left-0 z-10 bg-background before:absolute before:inset-0 before:-z-10 before:bg-muted/50">
            Organization
          </div>
          {hasMultipleSources && (
            <div className="h-full p-3 flex items-center flex-[1.1]">Source</div>
          )}
          <div className="h-full p-3 flex items-center flex-[1.6]">Destination</div>
          <div className="h-full p-3 flex items-center flex-[1]">Repositories</div>
          <div className="h-full p-3 flex items-center flex-[1]">Last Mirrored</div>
          <div className="h-full p-3 flex items-center flex-[0.9]">Status</div>
          <div className="h-full p-3 flex items-center flex-[1.3]">Actions</div>
          <div className="h-full p-3 flex items-center justify-center flex-[0.6]">Links</div>
        </div>

        {organizations.map((org) => {
          const orgId = org.id ?? "";
          const isLoading = loadingOrgIds.has(orgId);
          const statusBadge = getOrganizationStatusBadge(org.status);
          const StatusIcon = statusBadge.icon ? STATUS_ICONS[statusBadge.icon] : null;
          const source = resolveOrganizationSource(org, sources, sourceProvider, sourceUrl);
          const SourceIcon = SOURCE_PROVIDER_ICONS[source.provider];
          const breakdown = describeRepositoryBreakdown(org, "long");
          const destinationUrl = getDestinationUrl(org);
          const destinationTooltip = destinationLinkTooltip(org, destinationUrl);

          return (
            <div
              key={org.id ?? org.name}
              data-testid="organization-row"
              className={cn(
                "group min-h-[48px] flex items-center border-b last:border-b-0 hover:bg-muted/50",
                isLoading && "opacity-75"
              )}
            >
              {/* Organization. Pinned to the left edge so the row stays
                  identifiable while a narrow screen scrolls the rest. */}
              <div className="h-full px-3 py-2 flex items-center gap-2 flex-[2.2] min-w-0 sticky left-0 z-10 bg-background before:absolute before:inset-0 before:-z-10 group-hover:before:bg-muted/50">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <a
                      href={`${withBase("/repositories")}?organization=${encodeURIComponent(org.name || "")}`}
                      className="font-medium hover:underline truncate"
                      title={`Show the repositories of ${org.name}`}
                    >
                      {org.name}
                    </a>
                    <Badge
                      variant={org.membershipRole === "member" ? "secondary" : "default"}
                      className="capitalize shrink-0 px-1.5 text-[11px] font-normal"
                    >
                      {org.membershipRole.replace(/_/g, " ")}
                    </Badge>
                    {source.isPublicOnlySource && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 px-1.5 font-normal text-[11px]"
                        title="Mirrors public repositories only; its source has no account"
                      >
                        Public only
                      </Badge>
                    )}
                    {hasMirrorOverrides(org.mirrorOverrides) && (
                      <Badge
                        variant="outline"
                        className="shrink-0 px-1.5 text-[11px] font-normal text-amber-600 dark:text-amber-400 border-amber-500/40"
                        title="This organization overrides the global mirror options"
                      >
                        Custom
                      </Badge>
                    )}
                  </div>
                  {org.status === "failed" && org.errorMessage && (
                    <p
                      className="text-xs text-destructive truncate"
                      title={org.errorMessage}
                    >
                      {org.errorMessage}
                    </p>
                  )}
                </div>
              </div>

              {/* Source (multi-source only) */}
              {hasMultipleSources && (
                <div className="h-full px-3 py-2 flex items-center flex-[1.1] min-w-0">
                  <OrganizationSourceEditor
                    sources={sources ?? []}
                    value={source.pinnedSource?.id ?? null}
                    disabled={isLoading}
                    onUpdateSource={(sourceId) => onUpdateSource(orgId, sourceId)}
                    compact
                  />
                </div>
              )}

              {/* Destination */}
              <div className="h-full px-3 py-2 flex items-center flex-[1.6] min-w-0">
                <MirrorDestinationEditor
                  organizationId={orgId}
                  organizationName={org.name!}
                  currentDestination={org.destinationOrg ?? undefined}
                  defaultDestination={defaultDestinationFor(org.name!)}
                  onUpdate={(next) => onUpdateDestination(orgId, next)}
                  onMoveMirrors={
                    onMoveMirrors
                      ? (next, dryRun) => onMoveMirrors(orgId, next, dryRun)
                      : undefined
                  }
                  destinationLabel={destination.label}
                  isUpdating={isLoading}
                  compact
                />
              </div>

              {/* Repositories */}
              <div className="h-full px-3 py-2 flex items-center flex-[1] min-w-0">
                <div className="min-w-0">
                  <p className="text-sm">
                    <span className="font-semibold tabular-nums">{org.repositoryCount}</span>
                    <span className="text-muted-foreground ml-1">
                      {org.repositoryCount === 1 ? "repository" : "repositories"}
                    </span>
                  </p>
                  {breakdown.length > 0 && (
                    <p className="text-xs text-muted-foreground truncate" title={breakdown.join(", ")}>
                      {breakdown.join(" | ")}
                    </p>
                  )}
                </div>
              </div>

              {/* Last Mirrored */}
              <div className="h-full px-3 py-2 flex items-center flex-[1]">
                <p className="text-sm">{formatLastSyncTime(org.lastMirrored ?? null)}</p>
              </div>

              {/* Status */}
              <div className="h-full px-3 py-2 flex items-center flex-[0.9]">
                {org.status === "failed" && org.errorMessage ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="destructive" className="cursor-help flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" />
                          {statusBadge.label}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p className="text-sm">{org.errorMessage}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <Badge variant={statusBadge.variant} className="flex items-center gap-1">
                    {StatusIcon && (
                      <StatusIcon
                        className={cn("h-3 w-3", org.status === "mirroring" && "animate-pulse")}
                      />
                    )}
                    {statusBadge.label}
                  </Badge>
                )}
              </div>

              {/* Actions */}
              <div className="h-full px-3 py-2 flex items-center gap-1 flex-[1.3]">
                {org.status === "ignored" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => orgId && onIgnore && onIgnore({ orgId, ignore: false })}
                    disabled={isLoading}
                  >
                    <Check className="h-4 w-4 mr-1.5" />
                    Include
                  </Button>
                ) : org.status === "imported" ? (
                  <Button size="sm" onClick={() => orgId && onMirror({ orgId })} disabled={isLoading}>
                    <RefreshCw className={cn("h-4 w-4 mr-1.5", isLoading && "animate-spin")} />
                    {isLoading ? "Starting" : "Mirror"}
                  </Button>
                ) : org.status === "mirroring" ? (
                  <Button size="sm" variant="outline" disabled>
                    <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" />
                    Mirroring
                  </Button>
                ) : org.status === "failed" ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => orgId && onMirror({ orgId })}
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" />
                    ) : (
                      <AlertCircle className="h-4 w-4 mr-1.5" />
                    )}
                    {isLoading ? "Retrying" : "Retry"}
                  </Button>
                ) : org.status === "mirrored" && onSync ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => orgId && onSync({ orgId })}
                    disabled={isLoading}
                    title="Re-sync this organization now"
                  >
                    <RefreshCw className={cn("h-4 w-4 mr-1.5", isLoading && "animate-spin")} />
                    Sync
                  </Button>
                ) : null}
                <OrganizationActionsMenu
                  org={org}
                  disabled={isLoading}
                  onSync={onSync}
                  onIgnore={onIgnore}
                  onDelete={onDelete}
                  onEditMirrorOptions={onEditMirrorOptions}
                  triggerClassName="h-8 w-8"
                />
              </div>

              {/* Links */}
              <div className="h-full px-3 py-2 flex items-center justify-center gap-x-1 flex-[0.6]">
                {destinationUrl ? (
                  <Button variant="ghost" size="icon" asChild className="h-8 w-8">
                    <a
                      href={destinationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={destinationTooltip}
                    >
                      <DestinationIcon provider={destination.provider} className="h-4 w-4" />
                    </a>
                  </Button>
                ) : (
                  <Button variant="ghost" size="icon" disabled title={destinationTooltip} className="h-8 w-8">
                    <DestinationIcon provider={destination.provider} className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="ghost" size="icon" asChild className="h-8 w-8">
                  <a
                    href={`${source.sourceUrl}/${org.name}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`View on ${source.label}`}
                  >
                    <SourceIcon className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
