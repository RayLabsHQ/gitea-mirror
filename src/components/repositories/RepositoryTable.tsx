import { useMemo, useRef } from "react";
import Fuse from "fuse.js";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FlipHorizontal, GitFork, RefreshCw, RotateCcw, Star, Lock, Ban, Check, ChevronDown, Trash2, X } from "lucide-react";
import { SiGithub, SiGitea } from "react-icons/si";
import type { Repository } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { formatDate, formatLastSyncTime, getStatusColor } from "@/lib/utils";
import type { FilterParams } from "@/types/filter";
import { Skeleton } from "@/components/ui/skeleton";
import { useGiteaConfig } from "@/hooks/useGiteaConfig";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineDestinationEditor } from "./InlineDestinationEditor";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface RepositoryTableProps {
  repositories: Repository[];
  isLoading: boolean;
  isLiveActive?: boolean;
  filter: FilterParams;
  setFilter: (filter: FilterParams) => void;
  onMirror: ({ repoId }: { repoId: string }) => Promise<void>;
  onSync: ({ repoId }: { repoId: string }) => Promise<void>;
  onRetry: ({ repoId }: { repoId: string }) => Promise<void>;
  onSkip: ({ repoId, skip }: { repoId: string; skip: boolean }) => Promise<void>;
  loadingRepoIds: Set<string>;
  selectedRepoIds: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
  onRefresh?: () => Promise<void>;
  onDelete?: (repoId: string) => void;
  onApproveSync?: ({ repoId }: { repoId: string }) => Promise<void>;
  onDismissSync?: ({ repoId }: { repoId: string }) => Promise<void>;
}

export default function RepositoryTable({
  repositories,
  isLoading,
  isLiveActive = false,
  filter,
  setFilter,
  onMirror,
  onSync,
  onRetry,
  onSkip,
  loadingRepoIds,
  selectedRepoIds,
  onSelectionChange,
  onRefresh,
  onDelete,
  onApproveSync,
  onDismissSync,
}: RepositoryTableProps) {
  const tableParentRef = useRef<HTMLDivElement>(null);
  const { giteaConfig } = useGiteaConfig();

  const handleUpdateDestination = async (repoId: string, newDestination: string | null) => {
    // Call API to update repository destination
    const response = await fetch(`/api/repositories/${repoId}`, {
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
      throw new Error(errorData.error || "Failed to update repository");
    }

    // Refresh repositories data
    if (onRefresh) {
      await onRefresh();
    }
  };

  // Helper function to construct Gitea repository URL
  const getGiteaRepoUrl = (repository: Repository): string | null => {
    if (!giteaConfig?.url) {
      return null;
    }

    // Only provide Gitea links for repositories that have been or are being mirrored
    const validStatuses = ['mirroring', 'mirrored', 'syncing', 'synced', 'archived'];
    if (!validStatuses.includes(repository.status)) {
      return null;
    }

    // Use mirroredLocation if available, otherwise construct from repository data
    let repoPath: string;
    if (repository.mirroredLocation) {
      repoPath = repository.mirroredLocation;
    } else {
      // Fallback: construct the path based on repository data
      const owner = repository.organization || repository.owner;
      repoPath = `${owner}/${repository.name}`;
    }

    // Ensure the base URL doesn't have a trailing slash
    const baseUrl = giteaConfig.url.endsWith('/')
      ? giteaConfig.url.slice(0, -1)
      : giteaConfig.url;

    return `${baseUrl}/${repoPath}`;
  };

  const hasAnyFilter = Object.values(filter).some(
    (val) => val?.toString().trim() !== ""
  );

  const filteredRepositories = useMemo(() => {
    let result = repositories;

    if (filter.status) {
      result = result.filter((repo) => repo.status === filter.status);
    }

    if (filter.owner) {
      result = result.filter((repo) => repo.owner === filter.owner);
    }

    if (filter.organization) {
      result = result.filter(
        (repo) => repo.organization === filter.organization
      );
    }

    if (filter.searchTerm) {
      const fuse = new Fuse(result, {
        keys: ["name", "fullName", "owner", "organization"],
        threshold: 0.3,
      });
      result = fuse.search(filter.searchTerm).map((res) => res.item);
    }

    return result;
  }, [repositories, filter]);

  const rowVirtualizer = useVirtualizer({
    count: filteredRepositories.length,
    getScrollElement: () => tableParentRef.current,
    estimateSize: () => 65,
    overscan: 5,
  });

  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allIds = new Set(filteredRepositories.map(repo => repo.id).filter((id): id is string => !!id));
      onSelectionChange(allIds);
    } else {
      onSelectionChange(new Set());
    }
  };

  const handleSelectRepo = (repoId: string, checked: boolean) => {
    const newSelection = new Set(selectedRepoIds);
    if (checked) {
      newSelection.add(repoId);
    } else {
      newSelection.delete(repoId);
    }
    onSelectionChange(newSelection);
  };

  const isAllSelected = filteredRepositories.length > 0 && 
    filteredRepositories.every(repo => repo.id && selectedRepoIds.has(repo.id));
  const isPartiallySelected = selectedRepoIds.size > 0 && !isAllSelected;

  // Mobile card layout for repository
  const RepositoryCard = ({ repo }: { repo: Repository }) => {
    const isLoading = repo.id ? loadingRepoIds.has(repo.id) : false;
    const isSelected = repo.id ? selectedRepoIds.has(repo.id) : false;
    const giteaUrl = getGiteaRepoUrl(repo);

    return (
      <Card className="mb-3">
        <CardContent className="p-4">
          <div className="flex flex-col gap-3">
            {/* Header with checkbox and repo name */}
            <div className="flex items-start gap-3">
              <Checkbox
                checked={isSelected}
                onCheckedChange={(checked) => repo.id && handleSelectRepo(repo.id, checked as boolean)}
                className="mt-1 h-5 w-5"
                aria-label={`Select ${repo.name}`}
              />
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-base truncate">{repo.name}</h3>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {repo.isPrivate && <Badge variant="secondary" className="text-xs h-5"><Lock className="h-3 w-3 mr-1" />Private</Badge>}
                  {repo.isForked && <Badge variant="secondary" className="text-xs h-5"><GitFork className="h-3 w-3 mr-1" />Fork</Badge>}
                  {repo.isStarred && <Badge variant="secondary" className="text-xs h-5"><Star className="h-3 w-3 mr-1" />Starred</Badge>}
                </div>
              </div>
            </div>

            {/* Repository details */}
            <div className="space-y-2">
              {/* Owner & Organization */}
              <div className="text-sm text-muted-foreground space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Owner:</span>
                  <span className="truncate">{repo.owner}</span>
                </div>
                {repo.organization && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Org:</span>
                    <span className="truncate">{repo.organization}</span>
                  </div>
                )}
                {repo.destinationOrg && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Dest:</span>
                    <span className="truncate">{repo.destinationOrg}</span>
                  </div>
                )}
              </div>

              {/* Status & Last Mirrored */}
              <div className="flex items-center justify-between">
                <Badge 
                  className={`capitalize
                    ${repo.status === 'imported' ? 'bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20 dark:text-yellow-400' :
                      repo.status === 'mirrored' || repo.status === 'synced' ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400' :
                      repo.status === 'mirroring' || repo.status === 'syncing' ? 'bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 dark:text-blue-400' :
                      repo.status === 'failed' ? 'bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400' :
                      repo.status === 'ignored' ? 'bg-gray-500/10 text-gray-600 hover:bg-gray-500/20 dark:text-gray-400' :
                      repo.status === 'skipped' ? 'bg-orange-500/10 text-orange-600 hover:bg-orange-500/20 dark:text-orange-400' :
                      repo.status === 'pending-approval' ? 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400' :
                      'bg-muted hover:bg-muted/80'}`}
                  variant="secondary"
                >
                  {repo.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {formatLastSyncTime(repo.lastMirrored)}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2">
              {/* Primary action button */}
              {(repo.status === "imported" || repo.status === "failed") && (
                <Button
                  size="default"
                  variant="default"
                  onClick={() => repo.id && onMirror({ repoId: repo.id })}
                  disabled={isLoading}
                  className="w-full h-10"
                >
                  {isLoading ? (
                    <>
                      <FlipHorizontal className="h-4 w-4 mr-2 animate-spin" />
                      Mirroring...
                    </>
                  ) : (
                    <>
                      <FlipHorizontal className="h-4 w-4 mr-2" />
                      Mirror Repository
                    </>
                  )}
                </Button>
              )}
              {(repo.status === "mirrored" || repo.status === "synced") && (
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => repo.id && onSync({ repoId: repo.id })}
                  disabled={isLoading}
                  className="w-full h-10"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Syncing...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Sync Repository
                    </>
                  )}
                </Button>
              )}
              {repo.status === "failed" && (
                <Button
                  size="default"
                  variant="destructive"
                  onClick={() => repo.id && onRetry({ repoId: repo.id })}
                  disabled={isLoading}
                  className="w-full h-10"
                >
                  {isLoading ? (
                    <>
                      <RotateCcw className="h-4 w-4 mr-2 animate-spin" />
                      Retrying...
                    </>
                  ) : (
                    <>
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Retry Mirror
                    </>
                  )}
                </Button>
              )}
              {repo.status === "pending-approval" && (
                <div className="flex gap-2 w-full">
                  <Button
                    size="default"
                    variant="default"
                    onClick={() => repo.id && onApproveSync?.({ repoId: repo.id })}
                    disabled={isLoading}
                    className="flex-1 h-10"
                  >
                    {isLoading ? (
                      <>
                        <Check className="h-4 w-4 mr-2 animate-spin" />
                        Approving...
                      </>
                    ) : (
                      <>
                        <Check className="h-4 w-4 mr-2" />
                        Approve Sync
                      </>
                    )}
                  </Button>
                  <Button
                    size="default"
                    variant="outline"
                    onClick={() => repo.id && onDismissSync?.({ repoId: repo.id })}
                    disabled={isLoading}
                    className="flex-1 h-10"
                  >
                    <X className="h-4 w-4 mr-2" />
                    Dismiss
                  </Button>
                </div>
              )}

              {/* Ignore/Include button */}
              {repo.status === "ignored" ? (
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => repo.id && onSkip({ repoId: repo.id, skip: false })}
                  disabled={isLoading}
                  className="w-full h-10"
                >
                  <Check className="h-4 w-4 mr-2" />
                  Include Repository
                </Button>
              ) : (
                <Button
                  size="default"
                  variant="ghost"
                  onClick={() => repo.id && onSkip({ repoId: repo.id, skip: true })}
                  disabled={isLoading}
                  className="w-full h-10"
                >
                  <Ban className="h-4 w-4 mr-2" />
                  Ignore Repository
                </Button>
              )}
              
              {/* External links */}
              <div className="flex gap-2">
                <Button variant="outline" size="default" className="flex-1 h-10 min-w-0" asChild>
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on GitHub"
                    className="flex items-center justify-center gap-2"
                  >
                    <SiGithub className="h-4 w-4 flex-shrink-0" />
                    <span className="text-xs">GitHub</span>
                  </a>
                </Button>
                {giteaUrl ? (
                  <Button variant="outline" size="default" className="flex-1 h-10 min-w-0" asChild>
                    <a
                      href={giteaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="View on Gitea"
                      className="flex items-center justify-center gap-2"
                    >
                      <SiGitea className="h-4 w-4 flex-shrink-0" />
                      <span className="text-xs">Gitea</span>
                    </a>
                  </Button>
                ) : (
                  <Button variant="outline" size="default" disabled className="flex-1 h-10 min-w-0">
                    <SiGitea className="h-4 w-4" />
                    <span className="text-xs ml-2">Gitea</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  return isLoading ? (
    <div className="space-y-3 lg:space-y-0">
      {/* Mobile skeleton */}
      <div className="lg:hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="mb-3">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <Skeleton className="h-4 w-4 mt-1" />
                <div className="flex-1 space-y-3">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-1/3" />
                  <div className="flex gap-2">
                    <Skeleton className="h-8 w-20" />
                    <Skeleton className="h-8 w-8" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Desktop skeleton */}
      <div className="hidden lg:block border rounded-md">
        <div className="h-[45px] flex items-center justify-between border-b bg-muted/50">
          <div className="h-full p-3 flex items-center justify-center flex-[0.3]">
            <Skeleton className="h-4 w-4" />
          </div>
          <div className="h-full py-3 text-sm font-medium flex-[2.3]">
            Repository
          </div>
          <div className="h-full p-3 text-sm font-medium flex-[1]">Owner</div>
          <div className="h-full p-3 text-sm font-medium flex-[1]">
            Organization
          </div>
          <div className="h-full p-3 text-sm font-medium flex-[1]">
            Last Mirrored
          </div>
          <div className="h-full p-3 text-sm font-medium flex-[1]">Status</div>
          <div className="h-full p-3 text-sm font-medium flex-[1]">
            Actions
          </div>
          <div className="h-full p-3 text-sm font-medium flex-[0.8] text-center">
            Links
          </div>
        </div>

        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-[65px] flex items-center justify-between border-b bg-transparent"
          >
            <div className="h-full p-3 flex items-center justify-center flex-[0.3]">
              <Skeleton className="h-4 w-4" />
            </div>
            <div className="h-full p-3 flex-[2.3]">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-24 mt-1" />
            </div>
            <div className="h-full p-3 flex-[1]">
              <Skeleton className="h-4 w-20" />
            </div>
            <div className="h-full p-3 flex-[1]">
              <Skeleton className="h-4 w-20" />
            </div>
            <div className="h-full p-3 flex-[1]">
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="h-full p-3 flex-[1]">
              <Skeleton className="h-4 w-16" />
            </div>
            <div className="h-full p-3 flex-[1]">
              <Skeleton className="h-8 w-20" />
            </div>
            <div className="h-full p-3 flex-[0.8] flex items-center justify-center gap-1">
              <Skeleton className="h-8 w-8" />
              <Skeleton className="h-8 w-8" />
            </div>
          </div>
        ))}
      </div>
    </div>
  ) : (
    <div>
      {hasAnyFilter && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            Showing {filteredRepositories.length} of {repositories.length} repositories
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setFilter({
                searchTerm: "",
                status: "",
                organization: "",
                owner: "",
              })
            }
          >
            Clear filters
          </Button>
        </div>
      )}

      {filteredRepositories.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-muted-foreground">
            {hasAnyFilter
              ? "No repositories match the current filters"
              : "No repositories found"}
          </p>
        </div>
      ) : (
        <>
          {/* Mobile card view */}
          <div className="lg:hidden pb-20">
            {/* Select all checkbox */}
            <div className="flex items-center gap-3 mb-3 p-3 bg-muted/50 rounded-md">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={handleSelectAll}
                aria-label="Select all repositories"
                className="h-5 w-5"
              />
              <span className="text-sm font-medium">
                Select All ({filteredRepositories.length})
              </span>
            </div>

            {/* Repository cards */}
            {filteredRepositories.map((repo) => (
              <RepositoryCard key={repo.id} repo={repo} />
            ))}
          </div>

          {/* Desktop table view */}
          <div className="hidden lg:flex flex-col border rounded-md">
            {/* Table header */}
            <div className="h-[45px] flex items-center justify-between border-b bg-muted/50">
              <div className="h-full p-3 flex items-center justify-center flex-[0.3]">
                <Checkbox
                  checked={isAllSelected}
                  onCheckedChange={handleSelectAll}
                  aria-label="Select all repositories"
                />
              </div>
              <div className="h-full py-3 text-sm font-medium flex-[2.3]">
                Repository
              </div>
              <div className="h-full p-3 text-sm font-medium flex-[1]">Owner</div>
              <div className="h-full p-3 text-sm font-medium flex-[1]">
                Organization
              </div>
              <div className="h-full p-3 text-sm font-medium flex-[1]">
                Last Mirrored
              </div>
              <div className="h-full p-3 text-sm font-medium flex-[1]">Status</div>
              <div className="h-full p-3 text-sm font-medium flex-[1]">
                Actions
              </div>
              <div className="h-full p-3 text-sm font-medium flex-[0.8] text-center">
                Links
              </div>
            </div>

            {/* Table body wrapper (for a parent in virtualization) */}
            <div
              ref={tableParentRef}
              className="flex flex-col max-h-[calc(100dvh-276px)] overflow-y-auto"
            >
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  position: "relative",
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow, index) => {
                  const repo = filteredRepositories[virtualRow.index];
                  const isLoading = loadingRepoIds.has(repo.id ?? "");

                  return (
                    <div
                      key={index}
                      ref={rowVirtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        transform: `translateY(${virtualRow.start}px)`,
                        width: "100%",
                      }}
                      data-index={virtualRow.index}
                      className="h-[65px] flex items-center justify-between bg-transparent border-b hover:bg-muted/50"
                    >
                      {/* Checkbox */}
                      <div className="h-full p-3 flex items-center justify-center flex-[0.3]">
                        <Checkbox
                          checked={repo.id ? selectedRepoIds.has(repo.id) : false}
                          onCheckedChange={(checked) => repo.id && handleSelectRepo(repo.id, !!checked)}
                          aria-label={`Select ${repo.name}`}
                        />
                      </div>

                      {/* Repository */}
                      <div className="h-full py-3 flex items-center gap-2 flex-[2.3]">
                        <div className="flex-1">
                          <div className="font-medium flex items-center gap-1">
                            {repo.name}
                            {repo.isStarred && (
                              <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" />
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {repo.fullName}
                          </div>
                        </div>
                        {repo.isPrivate && (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">
                            Private
                          </span>
                        )}
                        {repo.isForked && (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">
                            Fork
                          </span>
                        )}
                      </div>
                      {/* Owner */}
                      <div className="h-full p-3 flex items-center flex-[1]">
                        <p className="text-sm">{repo.owner}</p>
                      </div>

                      {/* Organization */}
                      <div className="h-full p-3 flex items-center flex-[1]">
                        <InlineDestinationEditor
                          repository={repo}
                          giteaConfig={giteaConfig}
                          onUpdate={handleUpdateDestination}
                          isUpdating={loadingRepoIds.has(repo.id ?? "")}
                        />
                      </div>

                      {/* Last Mirrored */}
                      <div className="h-full p-3 flex items-center flex-[1]">
                        <p className="text-sm">
                          {formatLastSyncTime(repo.lastMirrored)}
                        </p>
                      </div>

                      {/* Status */}
                      <div className="h-full p-3 flex items-center flex-[1]">
                        {repo.status === "failed" && repo.errorMessage ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge 
                                  variant="destructive"
                                  className="cursor-help capitalize"
                                >
                                  {repo.status}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                <p className="text-sm">{repo.errorMessage}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <Badge 
                            className={`capitalize
                              ${repo.status === 'imported' ? 'bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20 dark:text-yellow-400' :
                                repo.status === 'mirrored' || repo.status === 'synced' ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400' :
                                repo.status === 'mirroring' || repo.status === 'syncing' ? 'bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 dark:text-blue-400' :
                                repo.status === 'failed' ? 'bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400' :
                                repo.status === 'ignored' ? 'bg-gray-500/10 text-gray-600 hover:bg-gray-500/20 dark:text-gray-400' :
                                repo.status === 'skipped' ? 'bg-orange-500/10 text-orange-600 hover:bg-orange-500/20 dark:text-orange-400' :
                                repo.status === 'pending-approval' ? 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400' :
                                'bg-muted hover:bg-muted/80'}`}
                            variant="secondary"
                          >
                            {repo.status}
                          </Badge>
                        )}
                      </div>
                      {/* Actions */}
                      <div className="h-full p-3 flex items-center justify-start flex-[1]">
                        <RepoActionButton
                          repo={{ id: repo.id ?? "", status: repo.status }}
                          isLoading={isLoading}
                          onMirror={() => onMirror({ repoId: repo.id ?? "" })}
                          onSync={() => onSync({ repoId: repo.id ?? "" })}
                          onRetry={() => onRetry({ repoId: repo.id ?? "" })}
                          onSkip={(skip) => onSkip({ repoId: repo.id ?? "", skip })}
                          onDelete={onDelete && repo.id ? () => onDelete(repo.id as string) : undefined}
                          onApproveSync={onApproveSync ? () => onApproveSync({ repoId: repo.id ?? "" }) : undefined}
                          onDismissSync={onDismissSync ? () => onDismissSync({ repoId: repo.id ?? "" }) : undefined}
                        />
                      </div>
                      {/* Links */}
                      <div className="h-full p-3 flex items-center justify-center gap-x-2 flex-[0.8]">
                        {(() => {
                          const giteaUrl = getGiteaRepoUrl(repo);

                          // Determine tooltip based on status and configuration
                          let tooltip: string;
                          if (!giteaConfig?.url) {
                            tooltip = "Gitea not configured";
                          } else if (repo.status === 'imported') {
                            tooltip = "Repository not yet mirrored to Gitea";
                          } else if (repo.status === 'failed') {
                            tooltip = "Repository mirroring failed";
                          } else if (repo.status === 'mirroring') {
                            tooltip = "Repository is being mirrored to Gitea";
                          } else if (giteaUrl) {
                            tooltip = "View on Gitea";
                          } else {
                            tooltip = "Gitea repository not available";
                          }

                          return giteaUrl ? (
                            <Button variant="ghost" size="icon" asChild>
                              <a
                                href={giteaUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={tooltip}
                              >
                                <SiGitea className="h-4 w-4" />
                              </a>
                            </Button>
                          ) : (
                            <Button variant="ghost" size="icon" disabled title={tooltip}>
                              <SiGitea className="h-4 w-4" />
                            </Button>
                          );
                        })()}
                        <Button variant="ghost" size="icon" asChild>
                          <a
                            href={repo.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View on GitHub"
                          >
                            <SiGithub className="h-4 w-4" />
                          </a>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Status Bar */}
            <div className="h-[40px] flex items-center justify-between border-t bg-muted/30 px-3 relative">
              <div className="flex items-center gap-2">
                <div className={`h-1.5 w-1.5 rounded-full ${isLiveActive ? 'bg-emerald-500' : 'bg-primary'}`} />
                <span className="text-sm font-medium text-foreground">
                  {hasAnyFilter
                    ? `Showing ${filteredRepositories.length} of ${repositories.length} repositories`
                    : `${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'} total`}
                </span>
              </div>

              {/* Center - Live active indicator */}
              {isLiveActive && (
                <div className="flex items-center gap-1.5 absolute left-1/2 transform -translate-x-1/2">
                  <div
                    className="h-1 w-1 rounded-full bg-emerald-500"
                    style={{
                      animation: 'pulse 2s ease-in-out infinite'
                    }}
                  />
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                    Live active
                  </span>
                  <div
                    className="h-1 w-1 rounded-full bg-emerald-500"
                    style={{
                      animation: 'pulse 2s ease-in-out infinite',
                      animationDelay: '1s'
                    }}
                  />
                </div>
              )}

              {hasAnyFilter && (
                <span className="text-xs text-muted-foreground">
                  Filters applied
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RepoActionButton({
  repo,
  isLoading,
  onMirror,
  onSync,
  onRetry,
  onSkip,
  onDelete,
  onApproveSync,
  onDismissSync,
}: {
  repo: { id: string; status: string };
  isLoading: boolean;
  onMirror: () => void;
  onSync: () => void;
  onRetry: () => void;
  onSkip: (skip: boolean) => void;
  onDelete?: () => void;
  onApproveSync?: () => void;
  onDismissSync?: () => void;
}) {
  // For pending-approval repos, show approve/dismiss actions
  if (repo.status === "pending-approval") {
    return (
      <div className="flex gap-1">
        <Button
          variant="default"
          size="sm"
          disabled={isLoading}
          onClick={onApproveSync}
          className="min-w-[70px]"
        >
          <Check className="h-4 w-4 mr-1" />
          Approve
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isLoading}
          onClick={onDismissSync}
        >
          <X className="h-4 w-4 mr-1" />
          Dismiss
        </Button>
      </div>
    );
  }

  // For ignored repos, show an "Include" action
  if (repo.status === "ignored") {
    return (
      <Button
        variant="outline"
        disabled={isLoading}
        onClick={() => onSkip(false)}
        className="min-w-[80px] justify-start"
      >
        <Check className="h-4 w-4 mr-1" />
        Include
      </Button>
    );
  }

  // For actionable statuses, show action + dropdown for skip
  let primaryLabel = "";
  let primaryIcon = <></>;
  let primaryOnClick = () => {};
  let primaryDisabled = isLoading;
  let showPrimaryAction = true;

  if (repo.status === "failed") {
    primaryLabel = "Retry";
    primaryIcon = <RotateCcw className="h-4 w-4" />;
    primaryOnClick = onRetry;
  } else if (["mirrored", "synced", "syncing", "archived"].includes(repo.status)) {
    primaryLabel = repo.status === "archived" ? "Manual Sync" : "Sync";
    primaryIcon = <RefreshCw className="h-4 w-4" />;
    primaryOnClick = onSync;
    primaryDisabled ||= repo.status === "syncing";
  } else if (["imported", "mirroring"].includes(repo.status)) {
    primaryLabel = "Mirror";
    primaryIcon = <FlipHorizontal className="h-4 w-4" />;
    primaryOnClick = onMirror;
    primaryDisabled ||= repo.status === "mirroring";
  } else {
    showPrimaryAction = false;
  }

  // If there's no primary action, just show ignore button
  if (!showPrimaryAction) {
    return (
      <Button
        variant="ghost"
        disabled={isLoading}
        onClick={() => onSkip(true)}
        className="min-w-[80px] justify-start"
      >
        <Ban className="h-4 w-4 mr-1" />
        Ignore
      </Button>
    );
  }

  // Show primary action with dropdown for additional actions
  return (
    <DropdownMenu>
      <div className="flex">
        <Button
          variant="ghost"
          disabled={primaryDisabled}
          onClick={primaryOnClick}
          className="min-w-[80px] justify-start rounded-r-none"
        >
          {isLoading ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin mr-1" />
              {primaryLabel}
            </>
          ) : (
            <>
              {primaryIcon}
              <span className="ml-1">{primaryLabel}</span>
            </>
          )}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            disabled={isLoading}
            className="rounded-l-none px-2 border-l"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onSkip(true)}>
          <Ban className="h-4 w-4 mr-2" />
          Ignore Repository
        </DropdownMenuItem>
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete from Mirror
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
