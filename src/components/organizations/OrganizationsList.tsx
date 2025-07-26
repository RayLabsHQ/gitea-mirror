import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, RefreshCw, Building2, Check, AlertCircle, Clock } from "lucide-react";
import { SiGithub, SiGitea } from "react-icons/si";
import type { Organization } from "@/lib/db/schema";
import type { FilterParams } from "@/types/filter";
import Fuse from "fuse.js";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { MirrorDestinationEditor } from "./MirrorDestinationEditor";
import { useGiteaConfig } from "@/hooks/useGiteaConfig";

interface OrganizationListProps {
  organizations: Organization[];
  isLoading: boolean;
  filter: FilterParams;
  setFilter: (filter: FilterParams) => void;
  onMirror: ({ orgId }: { orgId: string }) => Promise<void>;
  loadingOrgIds: Set<string>;
  onAddOrganization?: () => void;
  onRefresh?: () => Promise<void>;
}

// Helper function to get status badge variant and icon
const getStatusBadge = (status: string | null) => {
  switch (status) {
    case "imported":
      return { variant: "secondary" as const, label: "Not Mirrored", icon: null };
    case "mirroring":
      return { variant: "outline" as const, label: "Mirroring", icon: Clock };
    case "mirrored":
      return { variant: "default" as const, label: "Mirrored", icon: Check };
    case "failed":
      return { variant: "destructive" as const, label: "Failed", icon: AlertCircle };
    default:
      return { variant: "secondary" as const, label: "Unknown", icon: null };
  }
};

export function OrganizationList({
  organizations,
  isLoading,
  filter,
  setFilter,
  onMirror,
  loadingOrgIds,
  onAddOrganization,
  onRefresh,
}: OrganizationListProps) {
  const { giteaConfig } = useGiteaConfig();

  // Helper function to construct Gitea organization URL
  const getGiteaOrgUrl = (organization: Organization): string | null => {
    if (!giteaConfig?.url) {
      return null;
    }

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

    // Ensure the base URL doesn't have a trailing slash
    const baseUrl = giteaConfig.url.endsWith('/')
      ? giteaConfig.url.slice(0, -1)
      : giteaConfig.url;

    return `${baseUrl}/${orgName}`;
  };

  const handleUpdateDestination = async (orgId: string, newDestination: string | null) => {
    // Call API to update organization destination
    const response = await fetch(`/api/organizations/${orgId}`, {
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

    if (filter.searchTerm) {
      const fuse = new Fuse(result, {
        keys: ["name", "type"],
        threshold: 0.3,
      });
      result = fuse.search(filter.searchTerm).map((res) => res.item);
    }

    return result;
  }, [organizations, filter]);

  return isLoading ? (
    <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(27rem,1fr))] gap-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-[11.25rem] w-full" />
      ))}
    </div>
  ) : filteredOrganizations.length === 0 ? (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
      <h3 className="text-lg font-medium">No organizations found</h3>
      <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md">
        {hasAnyFilter
          ? "Try adjusting your search or filter criteria."
          : "Add GitHub organizations to mirror their repositories."}
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
  ) : (
    <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(27rem,1fr))] gap-4 pb-20 sm:pb-0">
      {filteredOrganizations.map((org, index) => {
        const isLoading = loadingOrgIds.has(org.id ?? "");
        const statusBadge = getStatusBadge(org.status);
        const StatusIcon = statusBadge.icon;

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
                      href={`/repositories?organization=${encodeURIComponent(org.name || '')}`}
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
                </div>
              </div>

              {/* Destination override section */}
              <div>
                <MirrorDestinationEditor
                  organizationId={org.id!}
                  organizationName={org.name!}
                  currentDestination={org.destinationOrg ?? undefined}
                  onUpdate={(newDestination) => handleUpdateDestination(org.id!, newDestination)}
                  isUpdating={isLoading}
                />
              </div>
            </div>

            {/* Desktop Layout */}
            <div className="hidden sm:block">
              {/* Header with org icon, name, role badge and status */}
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <a 
                        href={`/repositories?organization=${encodeURIComponent(org.name || '')}`}
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
                <Badge variant={statusBadge.variant} className="flex items-center gap-1">
                  {StatusIcon && <StatusIcon className={cn(
                    "h-3.5 w-3.5",
                    org.status === "mirroring" && "animate-pulse"
                  )} />}
                  {statusBadge.label}
                </Badge>
              </div>

              {/* Destination override section */}
              <div className="mb-4">
                <MirrorDestinationEditor
                  organizationId={org.id!}
                  organizationName={org.name!}
                  currentDestination={org.destinationOrg ?? undefined}
                  onUpdate={(newDestination) => handleUpdateDestination(org.id!, newDestination)}
                  isUpdating={isLoading}
                />
              </div>

              {/* Repository statistics */}
              <div className="mb-4">
                <div className="flex items-center gap-4 text-sm">
                  <div>
                    <span className="font-semibold text-lg">{org.repositoryCount}</span>
                    <span className="text-muted-foreground ml-1">
                      {org.repositoryCount === 1 ? "repository" : "repositories"}
                    </span>
                  </div>
                  
                  {/* Repository breakdown - TODO: Add these properties to Organization type */}
                  {/* Commented out until repository count breakdown is available
                  {isLoading || (org.status === "mirroring") ? (
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                    </div>
                  )}
                  */}
                </div>
              </div>
            </div>

            {/* Mobile Actions */}
            <div className="flex flex-col gap-3 sm:hidden">
              <div className="flex items-center gap-2">
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
              </div>
              
              <div className="flex items-center gap-2 justify-center">
                {(() => {
                  const giteaUrl = getGiteaOrgUrl(org);

                  // Determine tooltip based on status and configuration
                  let tooltip: string;
                  if (!giteaConfig?.url) {
                    tooltip = "Gitea not configured";
                  } else if (org.status === 'imported') {
                    tooltip = "Organization not yet mirrored to Gitea";
                  } else if (org.status === 'failed') {
                    tooltip = "Organization mirroring failed";
                  } else if (org.status === 'mirroring') {
                    tooltip = "Organization is being mirrored to Gitea";
                  } else if (giteaUrl) {
                    tooltip = "View on Gitea";
                  } else {
                    tooltip = "Gitea organization not available";
                  }

                  return giteaUrl ? (
                    <Button variant="outline" size="default" asChild className="flex-1 h-10 min-w-0">
                      <a
                        href={giteaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={tooltip}
                        className="flex items-center justify-center gap-2"
                      >
                        <SiGitea className="h-4 w-4 flex-shrink-0" />
                        <span className="text-xs">Gitea</span>
                      </a>
                    </Button>
                  ) : (
                    <Button variant="outline" size="default" disabled title={tooltip} className="flex-1 h-10">
                      <SiGitea className="h-4 w-4" />
                      <span className="text-xs ml-2">Gitea</span>
                    </Button>
                  );
                })()}
                <Button variant="outline" size="default" asChild className="flex-1 h-10 min-w-0">
                  <a
                    href={`https://github.com/${org.name}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on GitHub"
                    className="flex items-center justify-center gap-2"
                  >
                     <SiGithub className="h-4 w-4 flex-shrink-0" />
                     <span className="text-xs">GitHub</span>
                  </a>
                </Button>
              </div>
            </div>
            
            {/* Desktop Actions */}
            <div className="hidden sm:flex items-center justify-between mt-4">
              <div className="flex items-center gap-2">
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
              </div>

              <div className="flex items-center gap-2">
                {(() => {
                  const giteaUrl = getGiteaOrgUrl(org);

                  // Determine tooltip based on status and configuration
                  let tooltip: string;
                  if (!giteaConfig?.url) {
                    tooltip = "Gitea not configured";
                  } else if (org.status === 'imported') {
                    tooltip = "Organization not yet mirrored to Gitea";
                  } else if (org.status === 'failed') {
                    tooltip = "Organization mirroring failed";
                  } else if (org.status === 'mirroring') {
                    tooltip = "Organization is being mirrored to Gitea";
                  } else if (giteaUrl) {
                    tooltip = "View on Gitea";
                  } else {
                    tooltip = "Gitea organization not available";
                  }

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
                            <SiGitea className="h-4 w-4 mr-2" />
                            Gitea
                          </a>
                        ) : (
                          <>
                            <SiGitea className="h-4 w-4 mr-2" />
                            Gitea
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
                          href={`https://github.com/${org.name}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View on GitHub"
                        >
                          <SiGithub className="h-4 w-4 mr-2" />
                          GitHub
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
    </div>
  );
}
