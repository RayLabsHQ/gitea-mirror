import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Search, RefreshCw, FlipHorizontal, Filter } from "lucide-react";
import type { MirrorJob, Organization } from "@/lib/db/schema";
import { OrganizationList } from "./OrganizationsList";
import AddOrganizationDialog from "./AddOrganizationDialog";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, showErrorToast } from "@/lib/utils";
import {
  membershipRoleEnum,
  type AddOrganizationApiRequest,
  type AddOrganizationApiResponse,
  type MembershipRole,
  type OrganizationsApiResponse,
} from "@/types/organizations";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type { MirrorOrgRequest, MirrorOrgResponse } from "@/types/mirror";
import { useSSE } from "@/hooks/useSEE";
import { useFilterParams } from "@/hooks/useFilterParams";
import { toast } from "sonner";
import { useConfigStatus } from "@/hooks/useConfigStatus";
import { useNavigation } from "@/components/layout/MainLayout";
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

export function Organization() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isDialogOpen, setIsDialogOpen] = useState<boolean>(false);
  const { user } = useAuth();
  const { isGitHubConfigured } = useConfigStatus();
  const { navigationKey } = useNavigation();
  const { registerRefreshCallback } = useLiveRefresh();
  const { filter, setFilter } = useFilterParams({
    searchTerm: "",
    membershipRole: "",
    status: "",
  });
  const [loadingOrgIds, setLoadingOrgIds] = useState<Set<string>>(new Set()); // this is used when the api actions are performed

  // Create a stable callback using useCallback
  const handleNewMessage = useCallback((data: MirrorJob) => {
    if (data.organizationId) {
      setOrganizations((prevOrgs) =>
        prevOrgs.map((org) =>
          org.id === data.organizationId
            ? { ...org, status: data.status, details: data.details }
            : org
        )
      );
    }
  }, []);

  // Use the SSE hook
  const { connected } = useSSE({
    userId: user?.id,
    onMessage: handleNewMessage,
  });

  const fetchOrganizations = useCallback(async (isLiveRefresh = false) => {
    if (!user?.id) {
      return false;
    }

    // Don't fetch organizations if GitHub is not configured
    if (!isGitHubConfigured) {
      if (!isLiveRefresh) {
        setIsLoading(false);
      }
      return false;
    }

    try {
      if (!isLiveRefresh) {
        setIsLoading(true);
      }

      const response = await apiRequest<OrganizationsApiResponse>(
        `/github/organizations?userId=${user.id}`,
        {
          method: "GET",
        }
      );

      if (response.success) {
        setOrganizations(response.organizations);
        return true;
      } else {
        if (!isLiveRefresh) {
          toast.error(response.error || "Error fetching organizations");
        }
        return false;
      }
    } catch (error) {
      if (!isLiveRefresh) {
        toast.error(
          error instanceof Error ? error.message : "Error fetching organizations"
        );
      }
      return false;
    } finally {
      if (!isLiveRefresh) {
        setIsLoading(false);
      }
    }
  }, [user?.id, isGitHubConfigured]); // Only depend on user.id, not entire user object

  useEffect(() => {
    // Reset loading state when component becomes active
    setIsLoading(true);
    fetchOrganizations(false); // Manual refresh, not live
  }, [fetchOrganizations, navigationKey]); // Include navigationKey to trigger on navigation

  // Register with global live refresh system
  useEffect(() => {
    // Only register for live refresh if GitHub is configured
    if (!isGitHubConfigured) {
      return;
    }

    const unregister = registerRefreshCallback(() => {
      fetchOrganizations(true); // Live refresh
    });

    return unregister;
  }, [registerRefreshCallback, fetchOrganizations, isGitHubConfigured]);

  const handleRefresh = async () => {
    const success = await fetchOrganizations(false);
    if (success) {
      toast.success("Organizations refreshed successfully.");
    }
  };

  const handleMirrorOrg = async ({ orgId }: { orgId: string }) => {
    try {
      if (!user || !user.id) {
        return;
      }

      setLoadingOrgIds((prev) => new Set(prev).add(orgId));

      const reqPayload: MirrorOrgRequest = {
        userId: user.id,
        organizationIds: [orgId],
      };

      const response = await apiRequest<MirrorOrgResponse>("/job/mirror-org", {
        method: "POST",
        data: reqPayload,
      });

      if (response.success) {
        toast.success(`Mirroring started for organization ID: ${orgId}`);

        setOrganizations((prevOrgs) =>
          prevOrgs.map((org) => {
            const updated = response.organizations.find((o) => o.id === org.id);
            return updated ? updated : org;
          })
        );

        // Refresh organization data to get updated repository breakdown
        // Use a small delay to allow the backend to process the mirroring request
        setTimeout(() => {
          fetchOrganizations(true);
        }, 1000);
      } else {
        toast.error(response.error || "Error starting mirror job");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Error starting mirror job"
      );
    } finally {
      setLoadingOrgIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(orgId);
        return newSet;
      });
    }
  };

  const handleAddOrganization = async ({
    org,
    role,
  }: {
    org: string;
    role: MembershipRole;
  }) => {
    try {
      if (!user || !user.id) {
        return;
      }

      const reqPayload: AddOrganizationApiRequest = {
        userId: user.id,
        org,
        role,
      };

      const response = await apiRequest<AddOrganizationApiResponse>(
        "/sync/organization",
        {
          method: "POST",
          data: reqPayload,
        }
      );

      if (response.success) {
        toast.success(`Organization added successfully`);
        setOrganizations((prev) => [...prev, response.organization]);

        await fetchOrganizations();

        setFilter((prev) => ({
          ...prev,
          searchTerm: org,
        }));
      } else {
        showErrorToast(response.error || "Error adding organization", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMirrorAllOrgs = async () => {
    try {
      if (!user || !user.id || organizations.length === 0) {
        return;
      }

      // Filter out organizations that are already mirrored to avoid duplicate operations
      const eligibleOrgs = organizations.filter(
        (org) =>
          org.status !== "mirroring" && org.status !== "mirrored" && org.id
      );

      if (eligibleOrgs.length === 0) {
        toast.info("No eligible organizations to mirror");
        return;
      }

      // Get all organization IDs
      const orgIds = eligibleOrgs.map((org) => org.id as string);

      // Set loading state for all organizations being mirrored
      setLoadingOrgIds((prev) => {
        const newSet = new Set(prev);
        orgIds.forEach((id) => newSet.add(id));
        return newSet;
      });

      const reqPayload: MirrorOrgRequest = {
        userId: user.id,
        organizationIds: orgIds,
      };

      const response = await apiRequest<MirrorOrgResponse>("/job/mirror-org", {
        method: "POST",
        data: reqPayload,
      });

      if (response.success) {
        toast.success(`Mirroring started for ${orgIds.length} organizations`);
        setOrganizations((prevOrgs) =>
          prevOrgs.map((org) => {
            const updated = response.organizations.find((o) => o.id === org.id);
            return updated ? updated : org;
          })
        );
      } else {
        showErrorToast(response.error || "Error starting mirror jobs", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      // Reset loading states - we'll let the SSE updates handle status changes
      setLoadingOrgIds(new Set());
    }
  };

  // Check if any filters are active
  const hasActiveFilters = !!(filter.membershipRole || filter.status);
  const activeFilterCount = [filter.membershipRole, filter.status].filter(Boolean).length;

  // Clear all filters
  const clearFilters = () => {
    setFilter({
      searchTerm: filter.searchTerm,
      membershipRole: "",
      status: "",
    });
  };

  return (
    <div className="flex flex-col gap-y-4 sm:gap-y-8">
      {/* Search and filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4 w-full">
        {/* Mobile: Search bar with filter button */}
        <div className="flex items-center gap-2 w-full sm:hidden">
          <div className="relative flex-grow">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search organizations..."
              className="pl-10 pr-3 h-10 w-full rounded-md border border-input bg-background text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={filter.searchTerm}
              onChange={(e) =>
                setFilter((prev) => ({ ...prev, searchTerm: e.target.value }))
              }
            />
          </div>
          
          {/* Mobile Filter Drawer */}
          <Drawer>
            <DrawerTrigger asChild>
              <Button 
                variant="outline" 
                size="icon" 
                className="relative h-10 w-10 shrink-0"
              >
                <Filter className="h-4 w-4" />
                {activeFilterCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </DrawerTrigger>
            <DrawerContent className="max-h-[85vh]">
              <DrawerHeader className="text-left">
                <DrawerTitle className="text-lg font-semibold">Filter Organizations</DrawerTitle>
                <DrawerDescription className="text-sm text-muted-foreground">
                  Narrow down your organization list
                </DrawerDescription>
              </DrawerHeader>
              
              <div className="px-4 py-6 space-y-6 overflow-y-auto">
                {/* Active filters summary */}
                {hasActiveFilters && (
                  <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                    <span className="text-sm font-medium">
                      {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''} active
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearFilters}
                      className="h-7 px-2 text-xs"
                    >
                      Clear all
                    </Button>
                  </div>
                )}

                {/* Role Filter */}
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-2">
                    <span className="text-muted-foreground">By</span> Role
                    {filter.membershipRole && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {filter.membershipRole
                          .replace(/_/g, " ")
                          .replace(/\b\w/g, (c) => c.toUpperCase())}
                      </span>
                    )}
                  </label>
                  <Select
                    value={filter.membershipRole || "all"}
                    onValueChange={(value) =>
                      setFilter((prev) => ({
                        ...prev,
                        membershipRole: value === "all" ? "" : (value as MembershipRole),
                      }))
                    }
                  >
                    <SelectTrigger className="w-full h-10">
                      <SelectValue placeholder="All roles" />
                    </SelectTrigger>
                    <SelectContent>
                      {["all", ...membershipRoleEnum.options].map((role) => (
                        <SelectItem key={role} value={role}>
                          <span className="flex items-center gap-2">
                            {role !== "all" && (
                              <span className={`h-2 w-2 rounded-full ${
                                role === "admin" ? "bg-purple-500" : "bg-blue-500"
                              }`} />
                            )}
                            {role === "all"
                              ? "All roles"
                              : role
                                  .replace(/_/g, " ")
                                  .replace(/\b\w/g, (c) => c.toUpperCase())}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Status Filter */}
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-2">
                    <span className="text-muted-foreground">By</span> Status
                    {filter.status && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {filter.status.charAt(0).toUpperCase() + filter.status.slice(1)}
                      </span>
                    )}
                  </label>
                  <Select
                    value={filter.status || "all"}
                    onValueChange={(value) =>
                      setFilter((prev) => ({
                        ...prev,
                        status:
                          value === "all"
                            ? ""
                            : (value as
                                | ""
                                | "imported"
                                | "mirroring"
                                | "mirrored"
                                | "failed"
                                | "syncing"
                                | "synced"),
                      }))
                    }
                  >
                    <SelectTrigger className="w-full h-10">
                      <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        "all",
                        "imported",
                        "mirroring",
                        "mirrored",
                        "failed",
                        "syncing",
                        "synced",
                      ].map((status) => (
                        <SelectItem key={status} value={status}>
                          <span className="flex items-center gap-2">
                            {status !== "all" && (
                              <span className={`h-2 w-2 rounded-full ${
                                status === "synced" || status === "mirrored" ? "bg-green-500" :
                                status === "failed" ? "bg-red-500" :
                                status === "syncing" || status === "mirroring" ? "bg-blue-500" :
                                "bg-yellow-500"
                              }`} />
                            )}
                            {status === "all"
                              ? "All statuses"
                              : status.charAt(0).toUpperCase() + status.slice(1)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <DrawerFooter className="gap-2 px-4 pt-2 pb-4 border-t">
                <DrawerClose asChild>
                  <Button className="w-full" size="sm">
                    Apply Filters
                  </Button>
                </DrawerClose>
                <DrawerClose asChild>
                  <Button variant="outline" className="w-full" size="sm">
                    Cancel
                  </Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
          
          <Button
            variant="outline"
            size="icon"
            onClick={handleRefresh}
            title="Refresh organizations"
            className="h-10 w-10 shrink-0"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          
          <Button
            variant="default"
            size="icon"
            onClick={handleMirrorAllOrgs}
            disabled={isLoading || loadingOrgIds.size > 0}
            title="Mirror all organizations"
            className="h-10 w-10 shrink-0"
          >
            <FlipHorizontal className="h-4 w-4" />
          </Button>
        </div>

        {/* Desktop: Original layout */}
        <div className="hidden sm:flex sm:flex-row sm:items-center sm:gap-4 sm:w-full">
          <div className="relative flex-grow">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search organizations..."
              className="pl-10 pr-3 h-10 w-full rounded-md border border-input bg-background text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={filter.searchTerm}
              onChange={(e) =>
                setFilter((prev) => ({ ...prev, searchTerm: e.target.value }))
              }
            />
          </div>

          {/* Filter controls */}
          <div className="flex items-center gap-2">
            {/* Membership Role Filter */}
            <Select
              value={filter.membershipRole || "all"}
              onValueChange={(value) =>
                setFilter((prev) => ({
                  ...prev,
                  membershipRole: value === "all" ? "" : (value as MembershipRole),
                }))
              }
            >
              <SelectTrigger className="w-[140px] h-10">
                <SelectValue placeholder="All roles" />
              </SelectTrigger>
              <SelectContent>
                {["all", ...membershipRoleEnum.options].map((role) => (
                  <SelectItem key={role} value={role}>
                    <span className="flex items-center gap-2">
                      {role !== "all" && (
                        <span className={`h-2 w-2 rounded-full ${
                          role === "admin" ? "bg-purple-500" : "bg-blue-500"
                        }`} />
                      )}
                      {role === "all"
                        ? "All roles"
                        : role
                            .replace(/_/g, " ")
                            .replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Status Filter */}
            <Select
              value={filter.status || "all"}
              onValueChange={(value) =>
                setFilter((prev) => ({
                  ...prev,
                  status:
                    value === "all"
                      ? ""
                      : (value as
                          | ""
                          | "imported"
                          | "mirroring"
                          | "mirrored"
                          | "failed"
                          | "syncing"
                          | "synced"),
                }))
              }
            >
              <SelectTrigger className="w-[140px] h-10">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                {[
                  "all",
                  "imported",
                  "mirroring",
                  "mirrored",
                  "failed",
                  "syncing",
                  "synced",
                ].map((status) => (
                  <SelectItem key={status} value={status}>
                    <span className="flex items-center gap-2">
                      {status !== "all" && (
                        <span className={`h-2 w-2 rounded-full ${
                          status === "synced" || status === "mirrored" ? "bg-green-500" :
                          status === "failed" ? "bg-red-500" :
                          status === "syncing" || status === "mirroring" ? "bg-blue-500" :
                          "bg-yellow-500"
                        }`} />
                      )}
                      {status === "all"
                        ? "All statuses"
                        : status.charAt(0).toUpperCase() + status.slice(1)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant="outline"
              size="icon"
              onClick={handleRefresh}
              title="Refresh organizations"
              className="h-10 w-10"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>

            <Button
              variant="default"
              onClick={handleMirrorAllOrgs}
              disabled={isLoading || loadingOrgIds.size > 0}
              className="h-10 px-4"
            >
              <FlipHorizontal className="h-4 w-4 mr-2" />
              Mirror All
            </Button>
          </div>
        </div>
      </div>

      <OrganizationList
        organizations={organizations}
        isLoading={isLoading || !connected}
        filter={filter}
        setFilter={setFilter}
        loadingOrgIds={loadingOrgIds}
        onMirror={handleMirrorOrg}
        onAddOrganization={() => setIsDialogOpen(true)}
        onRefresh={async () => {
          await fetchOrganizations(false);
        }}
      />

      <AddOrganizationDialog
        onAddOrganization={handleAddOrganization}
        isDialogOpen={isDialogOpen}
        setIsDialogOpen={setIsDialogOpen}
      />
    </div>
  );
}
