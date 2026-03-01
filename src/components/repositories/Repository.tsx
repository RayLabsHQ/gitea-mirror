import { useCallback, useEffect, useState } from "react";
import RepositoryTable from "./RepositoryTable";
import type { MirrorJob, Repository } from "@/lib/db/schema";
import { useAuth } from "@/hooks/useAuth";
import {
  repoStatusEnum,
  type AddRepositoriesApiRequest,
  type AddRepositoriesApiResponse,
  type RepositoryApiResponse,
  type RepoStatus,
} from "@/types/Repository";
import { apiRequest, showErrorToast, getStatusColor } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Button } from "@/components/ui/button";
import { Search, RefreshCw, FlipHorizontal, RotateCcw, X, Filter, Ban, Check, LoaderCircle, Trash2 } from "lucide-react";
import type { MirrorRepoRequest, MirrorRepoResponse } from "@/types/mirror";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSSE } from "@/hooks/useSEE";
import { useFilterParams } from "@/hooks/useFilterParams";
import { toast } from "sonner";
import type { SyncRepoRequest, SyncRepoResponse } from "@/types/sync";
import { OwnerCombobox, OrganizationCombobox } from "./RepositoryComboboxes";
import type { RetryRepoRequest, RetryRepoResponse } from "@/types/retry";
import type { ResetMetadataRequest, ResetMetadataResponse } from "@/types/reset-metadata";
import AddRepositoryDialog from "./AddRepositoryDialog";

import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import { useConfigStatus } from "@/hooks/useConfigStatus";
import { useNavigation } from "@/components/layout/MainLayout";

export default function Repository() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const { user } = useAuth();
  const { registerRefreshCallback, isLiveEnabled } = useLiveRefresh();
  const { isGitHubConfigured, isFullyConfigured } = useConfigStatus();
  const { navigationKey } = useNavigation();
  const { filter, setFilter } = useFilterParams({
    searchTerm: "",
    status: "",
    organization: "",
    owner: "",
  });
  const [isDialogOpen, setIsDialogOpen] = useState<boolean>(false);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set());

  // Read organization filter from URL when component mounts
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const orgParam = urlParams.get("organization");

    if (orgParam) {
      setFilter((prev) => ({ ...prev, organization: orgParam }));
    }
  }, [setFilter]);

  const [loadingRepoIds, setLoadingRepoIds] = useState<Set<string>>(new Set()); // this is used when the api actions are performed
  const [duplicateRepoCandidate, setDuplicateRepoCandidate] = useState<{
    owner: string;
    repo: string;
  } | null>(null);
  const [isDuplicateRepoDialogOpen, setIsDuplicateRepoDialogOpen] = useState(false);
  const [isProcessingDuplicateRepo, setIsProcessingDuplicateRepo] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<Repository | null>(null);
  const [isDeleteRepoDialogOpen, setIsDeleteRepoDialogOpen] = useState(false);
  const [isDeletingRepo, setIsDeletingRepo] = useState(false);

  // Create a stable callback using useCallback
  const handleNewMessage = useCallback((data: MirrorJob) => {
    if (data.repositoryId) {
      setRepositories((prevRepos) =>
        prevRepos.map((repo) =>
          repo.id === data.repositoryId
            ? { ...repo, status: data.status, details: data.details }
            : repo
        )
      );
    }
  }, []);

  // Use the SSE hook
  const { connected } = useSSE({
    userId: user?.id,
    onMessage: handleNewMessage,
  });

  const fetchRepositories = useCallback(async (isLiveRefresh = false) => {
    if (!user?.id) return;

    // Don't fetch repositories if GitHub is not configured or still loading config
    if (!isGitHubConfigured) {
      setIsInitialLoading(false);
      return false;
    }

    try {
      // Set appropriate loading state based on refresh type
      if (!isLiveRefresh) {
        setIsInitialLoading(true);
      }

      const response = await apiRequest<RepositoryApiResponse>(
        `/github/repositories?userId=${user.id}`,
        {
          method: "GET",
        }
      );

      if (response.success) {
        setRepositories(response.repositories);
        return true;
      } else {
        // Only show error toast for manual refreshes to avoid spam during live updates
        if (!isLiveRefresh) {
          showErrorToast(response.error || "Error fetching repositories", toast);
        }
        return false;
      }
    } catch (error) {
      // Only show error toast for manual refreshes to avoid spam during live updates
      if (!isLiveRefresh) {
        showErrorToast(error, toast);
      }
      return false;
    } finally {
      if (!isLiveRefresh) {
        setIsInitialLoading(false);
      }
    }
  }, [user?.id, isGitHubConfigured]); // Only depend on user.id, not entire user object

  useEffect(() => {
    // Reset loading state when component becomes active
    setIsInitialLoading(true);
    fetchRepositories(false); // Manual refresh, not live
  }, [fetchRepositories, navigationKey]); // Include navigationKey to trigger on navigation

  // Register with global live refresh system
  useEffect(() => {
    // Only register for live refresh if GitHub is configured
    if (!isGitHubConfigured) {
      return;
    }

    const unregister = registerRefreshCallback(() => {
      fetchRepositories(true); // Live refresh
    });

    return unregister;
  }, [registerRefreshCallback, fetchRepositories, isGitHubConfigured]);

  const handleRefresh = async () => {
    const success = await fetchRepositories(false); // Manual refresh, show loading skeleton
    if (success) {
      toast.success("Repositories refreshed successfully.");
    }
  };

  const handleMirrorRepo = async ({ repoId }: { repoId: string }) => {
    try {
      if (!user || !user.id) {
        return;
      }

      setLoadingRepoIds((prev) => new Set(prev).add(repoId));

      const reqPayload: MirrorRepoRequest = {
        userId: user.id,
        repositoryIds: [repoId],
      };

      const response = await apiRequest<MirrorRepoResponse>(
        "/job/mirror-repo",
        {
          method: "POST",
          data: reqPayload,
        }
      );

      if (response.success) {
        const repo = repositories.find(r => r.id === repoId);
        const repoName = repo?.fullName || `repository ${repoId}`;
        toast.success(`Mirroring started for ${repoName}`);
        setRepositories((prevRepos) =>
          prevRepos.map((repo) => {
            const updated = response.repositories.find((r) => r.id === repo.id);
            return updated ? updated : repo;
          })
        );
      } else {
        showErrorToast(response.error || "Error starting mirror job", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setLoadingRepoIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(repoId);
        return newSet;
      });
    }
  };

  const handleMirrorAllRepos = async () => {
    try {
      if (!user || !user.id || repositories.length === 0) {
        return;
      }

      // Filter out repositories that are already mirroring, mirrored, or ignored
      const eligibleRepos = repositories.filter(
        (repo) =>
          repo.status !== "mirroring" && 
          repo.status !== "mirrored" && 
          repo.status !== "ignored" && // Skip ignored repositories
          repo.id
      );

      if (eligibleRepos.length === 0) {
        toast.info("No eligible repositories to mirror");
        return;
      }

      // Get all repository IDs
      const repoIds = eligibleRepos.map((repo) => repo.id as string);

      // Set loading state for all repositories being mirrored
      setLoadingRepoIds((prev) => {
        const newSet = new Set(prev);
        repoIds.forEach((id) => newSet.add(id));
        return newSet;
      });

      const reqPayload: MirrorRepoRequest = {
        userId: user.id,
        repositoryIds: repoIds,
      };

      const response = await apiRequest<MirrorRepoResponse>(
        "/job/mirror-repo",
        {
          method: "POST",
          data: reqPayload,
        }
      );

      if (response.success) {
        toast.success(`Mirroring started for ${repoIds.length} repositories`);
        setRepositories((prevRepos) =>
          prevRepos.map((repo) => {
            const updated = response.repositories.find((r) => r.id === repo.id);
            return updated ? updated : repo;
          })
        );
      } else {
        showErrorToast(response.error || "Error starting mirror jobs", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      // Reset loading states - we'll let the SSE updates handle status changes
      setLoadingRepoIds(new Set());
    }
  };

  // Bulk action handlers
  const handleBulkMirror = async () => {
    if (selectedRepoIds.size === 0) return;
    
    const selectedRepos = repositories.filter(repo => repo.id && selectedRepoIds.has(repo.id));
    const eligibleRepos = selectedRepos.filter(
      repo => repo.status === "imported" || repo.status === "failed"
    );

    if (eligibleRepos.length === 0) {
      toast.info("No eligible repositories to mirror in selection");
      return;
    }

    const repoIds = eligibleRepos.map(repo => repo.id as string);
    
    setLoadingRepoIds(prev => {
      const newSet = new Set(prev);
      repoIds.forEach(id => newSet.add(id));
      return newSet;
    });

    try {
      const response = await apiRequest<MirrorRepoResponse>("/job/mirror-repo", {
        method: "POST",
        data: { userId: user?.id, repositoryIds: repoIds }
      });

      if (response.success) {
        toast.success(`Mirroring started for ${repoIds.length} repositories`);
        setRepositories(prevRepos =>
          prevRepos.map(repo => {
            const updated = response.repositories.find(r => r.id === repo.id);
            return updated ? updated : repo;
          })
        );
        setSelectedRepoIds(new Set());
      } else {
        showErrorToast(response.error || "Error starting mirror jobs", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setLoadingRepoIds(new Set());
    }
  };

  const handleBulkSync = async () => {
    if (selectedRepoIds.size === 0) return;
    
    const selectedRepos = repositories.filter(repo => repo.id && selectedRepoIds.has(repo.id));
    const eligibleRepos = selectedRepos.filter(
      repo => ["mirrored", "synced", "archived"].includes(repo.status)
    );

    if (eligibleRepos.length === 0) {
      toast.info("No eligible repositories to sync in selection");
      return;
    }

    const repoIds = eligibleRepos.map(repo => repo.id as string);
    
    setLoadingRepoIds(prev => {
      const newSet = new Set(prev);
      repoIds.forEach(id => newSet.add(id));
      return newSet;
    });

    try {
      const response = await apiRequest<SyncRepoResponse>("/job/sync-repo", {
        method: "POST",
        data: { userId: user?.id, repositoryIds: repoIds }
      });

      if (response.success) {
        toast.success(`Syncing started for ${repoIds.length} repositories`);
        setRepositories(prevRepos =>
          prevRepos.map(repo => {
            const updated = response.repositories.find(r => r.id === repo.id);
            return updated ? updated : repo;
          })
        );
        setSelectedRepoIds(new Set());
      } else {
        showErrorToast(response.error || "Error starting sync jobs", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setLoadingRepoIds(new Set());
    }
  };

  const handleBulkRerunMetadata = async () => {
    if (selectedRepoIds.size === 0) return;

    const selectedRepos = repositories.filter(repo => repo.id && selectedRepoIds.has(repo.id));
    const eligibleRepos = selectedRepos.filter(
      repo => ["mirrored", "synced", "archived"].includes(repo.status)
    );

    if (eligibleRepos.length === 0) {
      toast.info("No eligible repositories to re-run metadata in selection");
      return;
    }

    const repoIds = eligibleRepos.map(repo => repo.id as string);

    setLoadingRepoIds(prev => {
      const newSet = new Set(prev);
      repoIds.forEach(id => newSet.add(id));
      return newSet;
    });

    try {
      const resetPayload: ResetMetadataRequest = {
        userId: user?.id || "",
        repositoryIds: repoIds,
      };

      const resetResponse = await apiRequest<ResetMetadataResponse>("/job/reset-metadata", {
        method: "POST",
        data: resetPayload,
      });

      if (!resetResponse.success) {
        showErrorToast(resetResponse.error || "Failed to reset metadata state", toast);
        return;
      }

      const syncResponse = await apiRequest<SyncRepoResponse>("/job/sync-repo", {
        method: "POST",
        data: { userId: user?.id, repositoryIds: repoIds },
      });

      if (syncResponse.success) {
        toast.success(`Re-running metadata for ${repoIds.length} repositories`);
        setRepositories(prevRepos =>
          prevRepos.map(repo => {
            const updated = syncResponse.repositories.find(r => r.id === repo.id);
            return updated ? updated : repo;
          })
        );
        setSelectedRepoIds(new Set());
      } else {
        showErrorToast(syncResponse.error || "Error starting metadata re-sync", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setLoadingRepoIds(new Set());
    }
  };

  const handleBulkRetry = async () => {
    if (selectedRepoIds.size === 0) return;
    
    const selectedRepos = repositories.filter(repo => repo.id && selectedRepoIds.has(repo.id));
    const eligibleRepos = selectedRepos.filter(repo => repo.status === "failed");

    if (eligibleRepos.length === 0) {
      toast.info("No failed repositories in selection to retry");
      return;
    }

    const repoIds = eligibleRepos.map(repo => repo.id as string);
    
    setLoadingRepoIds(prev => {
      const newSet = new Set(prev);
      repoIds.forEach(id => newSet.add(id));
      return newSet;
    });

    try {
      const response = await apiRequest<RetryRepoResponse>("/job/retry-repo", {
        method: "POST",
        data: { userId: user?.id, repositoryIds: repoIds }
      });

      if (response.success) {
        toast.success(`Retrying ${repoIds.length} repositories`);
        setRepositories(prevRepos =>
          prevRepos.map(repo => {
            const updated = response.repositories.find(r => r.id === repo.id);
            return updated ? updated : repo;
          })
        );
        setSelectedRepoIds(new Set());
      } else {
        showErrorToast(response.error || "Error retrying jobs", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setLoadingRepoIds(new Set());
    }
  };

  const handleBulkSkip = async (skip: boolean) => {
    if (selectedRepoIds.size === 0) return;
    
    const selectedRepos = repositories.filter(repo => repo.id && selectedRepoIds.has(repo.id));
    const eligibleRepos = skip 
      ? selectedRepos.filter(repo => 
          repo.status !== "ignored" && 
          repo.status !== "mirroring" && 
          repo.status !== "syncing"
        )
      : selectedRepos.filter(repo => repo.status === "ignored");

    if (eligibleRepos.length === 0) {
      toast.info(`No eligible repositories to ${skip ? "ignore" : "include"} in selection`);
      return;
    }

    const repoIds = eligibleRepos.map(repo => repo.id as string);
    
    setLoadingRepoIds(prev => {
      const newSet = new Set(prev);
      repoIds.forEach(id => newSet.add(id));
      return newSet;
    });

    try {
      // Update each repository's status
      const newStatus = skip ? "ignored" : "imported";
      const promises = repoIds.map(repoId => 
        apiRequest<{ success: boolean; repository?: Repository; error?: string }>(
          `/repositories/${repoId}/status`,
          {
            method: "PATCH",
            data: { status: newStatus, userId: user?.id },
          }
        )
      );
      
      const results = await Promise.allSettled(promises);
      const successCount = results.filter(r => r.status === "fulfilled" && (r.value as any).success).length;
      
      if (successCount > 0) {
        toast.success(`${successCount} repositories ${skip ? "ignored" : "included"}`);
        
        // Update local state for successful updates
        const successfulRepoIds = new Set<string>();
        results.forEach((result, index) => {
          if (result.status === "fulfilled" && (result.value as any).success) {
            successfulRepoIds.add(repoIds[index]);
          }
        });
        
        setRepositories(prevRepos =>
          prevRepos.map(repo => {
            if (repo.id && successfulRepoIds.has(repo.id)) {
              return { ...repo, status: newStatus as any };
            }
            return repo;
          })
        );
        
        setSelectedRepoIds(new Set());
      }
      
      if (successCount < repoIds.length) {
        toast.error(`Failed to ${skip ? "ignore" : "include"} ${repoIds.length - successCount} repositories`);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setLoadingRepoIds(new Set());
    }
  };

  const handleSyncRepo = async ({ repoId }: { repoId: string }) => {
    try {
      if (!user || !user.id) {
        return;
      }

      setLoadingRepoIds((prev) => new Set(prev).add(repoId));

      const reqPayload: SyncRepoRequest = {
        userId: user.id,
        repositoryIds: [repoId],
      };

      const response = await apiRequest<SyncRepoResponse>("/job/sync-repo", {
        method: "POST",
        data: reqPayload,
      });

      if (response.success) {
        const repo = repositories.find(r => r.id === repoId);
        const repoName = repo?.fullName || `repository ${repoId}`;
        toast.success(`Syncing started for ${repoName}`);
        setRepositories((prevRepos) =>
          prevRepos.map((repo) => {
            const updated = response.repositories.find((r) => r.id === repo.id);
            return updated ? updated : repo;
          })
        );
      } else {
        showErrorToast(response.error || "Error starting sync job", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setLoadingRepoIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(repoId);
        return newSet;
      });
    }
  };

  const handleSkipRepo = async ({ repoId, skip }: { repoId: string; skip: boolean }) => {
    try {
      if (!user || !user.id) {
        return;
      }

      // Check if repository is currently being processed
      const repo = repositories.find(r => r.id === repoId);
      if (skip && repo && (repo.status === "mirroring" || repo.status === "syncing")) {
        toast.warning("Cannot skip repository while it's being processed");
        return;
      }

      // Set loading state
      setLoadingRepoIds(prev => {
        const newSet = new Set(prev);
        newSet.add(repoId);
        return newSet;
      });

      const newStatus = skip ? "ignored" : "imported";
      
      // Update repository status via API
      const response = await apiRequest<{ success: boolean; repository?: Repository; error?: string }>(
        `/repositories/${repoId}/status`,
        {
          method: "PATCH",
          data: { status: newStatus, userId: user.id },
        }
      );

      if (response.success && response.repository) {
        toast.success(`Repository ${skip ? "ignored" : "included"}`);
        setRepositories(prevRepos =>
          prevRepos.map(repo =>
            repo.id === repoId ? response.repository! : repo
          )
        );
      } else {
        showErrorToast(response.error || `Error ${skip ? "ignoring" : "including"} repository`, toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setLoadingRepoIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(repoId);
        return newSet;
      });
    }
  };

  const handleRetryRepoAction = async ({ repoId }: { repoId: string }) => {
    try {
      if (!user || !user.id) {
        return;
      }

      setLoadingRepoIds((prev) => new Set(prev).add(repoId));

      const reqPayload: RetryRepoRequest = {
        userId: user.id,
        repositoryIds: [repoId],
      };

      const response = await apiRequest<RetryRepoResponse>("/job/retry-repo", {
        method: "POST",
        data: reqPayload,
      });

      if (response.success) {
        const repo = repositories.find(r => r.id === repoId);
        const repoName = repo?.fullName || `repository ${repoId}`;
        toast.success(`Retrying job for ${repoName}`);
        setRepositories((prevRepos) =>
          prevRepos.map((repo) => {
            const updated = response.repositories.find((r) => r.id === repo.id);
            return updated ? updated : repo;
          })
        );
      } else {
        showErrorToast(response.error || "Error retrying job", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setLoadingRepoIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(repoId);
        return newSet;
      });
    }
  };

  const handleAddRepository = async ({
    repo,
    owner,
    force = false,
    destinationOrg,
  }: {
    repo: string;
    owner: string;
    force?: boolean;
    destinationOrg?: string;
  }) => {
    if (!user || !user.id) {
      return;
    }

    const trimmedRepo = repo.trim();
    const trimmedOwner = owner.trim();

    if (!trimmedRepo || !trimmedOwner) {
      toast.error("Please provide both owner and repository name.");
      throw new Error("Invalid repository details");
    }

    const normalizedFullName = `${trimmedOwner}/${trimmedRepo}`.toLowerCase();

    if (!force) {
      const duplicateRepo = repositories.find(
        (existing) => existing.normalizedFullName?.toLowerCase() === normalizedFullName
      );

      if (duplicateRepo) {
        toast.warning("Repository already exists.");
        setDuplicateRepoCandidate({ repo: trimmedRepo, owner: trimmedOwner });
        setIsDuplicateRepoDialogOpen(true);
        throw new Error("Repository already exists");
      }
    }

    try {
      const reqPayload: AddRepositoriesApiRequest = {
        userId: user.id,
        repo: trimmedRepo,
        owner: trimmedOwner,
        force,
        ...(destinationOrg ? { destinationOrg } : {}),
      };

      const response = await apiRequest<AddRepositoriesApiResponse>(
        "/sync/repository",
        {
          method: "POST",
          data: reqPayload,
        }
      );

      if (response.success) {
        const message = force
          ? "Repository already exists; metadata refreshed."
          : "Repository added successfully";
        toast.success(message);

        await fetchRepositories(false);

        setFilter((prev) => ({
          ...prev,
          searchTerm: trimmedRepo,
        }));

        if (force) {
          setDuplicateRepoCandidate(null);
          setIsDuplicateRepoDialogOpen(false);
        }
      } else {
        showErrorToast(response.error || "Error adding repository", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
      throw error;
    }
  };

  // Get unique owners and organizations for comboboxes
  const ownerOptions = Array.from(
    new Set(
      repositories.map((repo) => repo.owner).filter((v): v is string => !!v)
    )
  ).sort();
  const orgOptions = Array.from(
    new Set(
      repositories
        .map((repo) => repo.organization)
        .filter((v): v is string => !!v)
    )
  ).sort();

  const handleConfirmDuplicateRepository = async () => {
    if (!duplicateRepoCandidate) {
      return;
    }

    setIsProcessingDuplicateRepo(true);
    try {
      await handleAddRepository({
        repo: duplicateRepoCandidate.repo,
        owner: duplicateRepoCandidate.owner,
        force: true,
      });
      setIsDialogOpen(false);
    } catch (error) {
      // Error already shown
    } finally {
      setIsProcessingDuplicateRepo(false);
    }
  };

  const handleCancelDuplicateRepository = () => {
    setDuplicateRepoCandidate(null);
    setIsDuplicateRepoDialogOpen(false);
  };

  const handleRequestDeleteRepository = (repoId: string) => {
    const repo = repositories.find((item) => item.id === repoId);
    if (!repo) {
      toast.error("Repository not found");
      return;
    }

    setRepoToDelete(repo);
    setIsDeleteRepoDialogOpen(true);
  };

  const handleDeleteRepository = async () => {
    if (!user || !user.id || !repoToDelete) {
      return;
    }

    setIsDeletingRepo(true);
    try {
      const response = await apiRequest<{ success: boolean; error?: string }>(
        `/repositories/${repoToDelete.id}`,
        {
          method: "DELETE",
        }
      );

      if (response.success) {
        toast.success(`Removed ${repoToDelete.fullName} from Gitea Mirror.`);
        await fetchRepositories(false);
      } else {
        showErrorToast(response.error || "Failed to delete repository", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsDeletingRepo(false);
      setIsDeleteRepoDialogOpen(false);
      setRepoToDelete(null);
    }
  };

  // Determine what actions are available for selected repositories
  const getAvailableActions = () => {
    if (selectedRepoIds.size === 0) return [];
    
    const selectedRepos = repositories.filter(repo => repo.id && selectedRepoIds.has(repo.id));
    
    const actions = [];
    
    // Check if any selected repos can be mirrored
    if (selectedRepos.some(repo => repo.status === "imported" || repo.status === "failed")) {
      actions.push('mirror');
    }
    
    // Check if any selected repos can be synced
    if (selectedRepos.some(repo => repo.status === "mirrored" || repo.status === "synced")) {
      actions.push('sync');
    }

    if (selectedRepos.some(repo => ["mirrored", "synced", "archived"].includes(repo.status))) {
      actions.push('rerun-metadata');
    }
    
    // Check if any selected repos are failed
    if (selectedRepos.some(repo => repo.status === "failed")) {
      actions.push('retry');
    }
    
    // Check if any selected repos can be ignored
    if (selectedRepos.some(repo => repo.status !== "ignored")) {
      actions.push('ignore');
    }
    
    // Check if any selected repos can be included (unignored)
    if (selectedRepos.some(repo => repo.status === "ignored")) {
      actions.push('include');
    }
    
    return actions;
  };
  
  const availableActions = getAvailableActions();
  
  // Get counts for eligible repositories for each action
  const getActionCounts = () => {
    const selectedRepos = repositories.filter(repo => repo.id && selectedRepoIds.has(repo.id));
    
    return {
      mirror: selectedRepos.filter(repo => repo.status === "imported" || repo.status === "failed").length,
      sync: selectedRepos.filter(repo => repo.status === "mirrored" || repo.status === "synced").length,
      rerunMetadata: selectedRepos.filter(repo => ["mirrored", "synced", "archived"].includes(repo.status)).length,
      retry: selectedRepos.filter(repo => repo.status === "failed").length,
      ignore: selectedRepos.filter(repo => repo.status !== "ignored").length,
      include: selectedRepos.filter(repo => repo.status === "ignored").length,
    };
  };
  
  const actionCounts = getActionCounts();

  // Check if any filters are active
  const hasActiveFilters = !!(filter.owner || filter.organization || filter.status);
  const activeFilterCount = [filter.owner, filter.organization, filter.status].filter(Boolean).length;

  // Clear all filters
  const clearFilters = () => {
    setFilter({
      searchTerm: filter.searchTerm,
      status: "",
      organization: "",
      owner: "",
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
              placeholder="Search repositories..."
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
                <DrawerTitle className="text-lg font-semibold">Filter Repositories</DrawerTitle>
                <DrawerDescription className="text-sm text-muted-foreground">
                  Narrow down your repository list
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

                {/* Owner Filter */}
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-2">
                    <span className="text-muted-foreground">By</span> Owner
                    {filter.owner && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        Selected
                      </span>
                    )}
                  </label>
                  <OwnerCombobox
                    options={ownerOptions}
                    value={filter.owner || ""}
                    onChange={(owner: string) =>
                      setFilter((prev) => ({ ...prev, owner }))
                    }
                  />
                </div>

                {/* Organization Filter */}
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-2">
                    <span className="text-muted-foreground">By</span> Organization
                    {filter.organization && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        Selected
                      </span>
                    )}
                  </label>
                  <OrganizationCombobox
                    options={orgOptions}
                    value={filter.organization || ""}
                    onChange={(organization: string) =>
                      setFilter((prev) => ({ ...prev, organization }))
                    }
                  />
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
                        status: value === "all" ? "" : (value as RepoStatus),
                      }))
                    }
                  >
                    <SelectTrigger className="w-full h-10">
                      <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      {["all", ...repoStatusEnum.options].map((status) => (
                        <SelectItem key={status} value={status}>
                          <span className="flex items-center gap-2">
                            {status !== "all" && (
                              <span className={`h-2 w-2 rounded-full ${getStatusColor(status)}`} />
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
            title="Refresh repositories"
            className="h-10 w-10 shrink-0"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          
          <Button
            variant="default"
            size="icon"
            onClick={handleMirrorAllRepos}
            disabled={isInitialLoading || loadingRepoIds.size > 0}
            title="Mirror all repositories"
            className="h-10 w-10 shrink-0"
          >
            <FlipHorizontal className="h-4 w-4" />
          </Button>
        </div>

        {/* Desktop: Original layout */}
        <div className="hidden sm:flex sm:flex-row sm:items-center sm:gap-4 sm:w-full">
          <div className="relative flex-grow min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search repositories..."
              className="pl-10 pr-3 h-10 w-full rounded-md border border-input bg-background text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={filter.searchTerm}
              onChange={(e) =>
                setFilter((prev) => ({ ...prev, searchTerm: e.target.value }))
              }
            />
          </div>

          {/* Owner Combobox */}
          <OwnerCombobox
            options={ownerOptions}
            value={filter.owner || ""}
            onChange={(owner: string) =>
              setFilter((prev) => ({ ...prev, owner }))
            }
          />

          {/* Organization Combobox */}
          <OrganizationCombobox
            options={orgOptions}
            value={filter.organization || ""}
            onChange={(organization: string) =>
              setFilter((prev) => ({ ...prev, organization }))
            }
          />

          {/* Filter controls in a responsive row */}
          <div className="flex flex-row items-center gap-2">
            <Select
              value={filter.status || "all"}
              onValueChange={(value) =>
                setFilter((prev) => ({
                  ...prev,
                  status: value === "all" ? "" : (value as RepoStatus),
                }))
              }
            >
              <SelectTrigger className="w-[140px] h-10">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                {["all", ...repoStatusEnum.options].map((status) => (
                  <SelectItem key={status} value={status}>
                    <span className="flex items-center gap-2">
                      {status !== "all" && (
                        <span className={`h-2 w-2 rounded-full ${getStatusColor(status)}`} />
                      )}
                      {status === "all"
                        ? "All statuses"
                        : status.charAt(0).toUpperCase() + status.slice(1)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="icon"
              onClick={handleRefresh}
              title="Refresh repositories"
              className="h-10 w-10 shrink-0"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {/* Bulk actions on desktop - integrated into the same line */}
          <div className="flex items-center gap-2 border-l pl-4">
            {selectedRepoIds.size === 0 ? (
              <Button
                variant="default"
                onClick={handleMirrorAllRepos}
                disabled={isInitialLoading || loadingRepoIds.size > 0}
                className="whitespace-nowrap"
              >
                <FlipHorizontal className="h-4 w-4 mr-2" />
                Mirror All
              </Button>
            ) : (
              <>
                <div className="flex items-center gap-2 px-3 py-1 bg-muted/50 rounded-md">
                  <span className="text-sm font-medium">
                    {selectedRepoIds.size} selected
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={() => setSelectedRepoIds(new Set())}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                
                {availableActions.includes('mirror') && (
                  <Button
                    variant="default"
                    size="default"
                    onClick={handleBulkMirror}
                    disabled={loadingRepoIds.size > 0}
                  >
                    <FlipHorizontal className="h-4 w-4 mr-2" />
                    Mirror ({actionCounts.mirror})
                  </Button>
                )}
                
                {availableActions.includes('sync') && (
                  <Button
                    variant="outline"
                    size="default"
                    onClick={handleBulkSync}
                    disabled={loadingRepoIds.size > 0}
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Sync ({actionCounts.sync})
                  </Button>
                )}

                {availableActions.includes('rerun-metadata') && (
                  <Button
                    variant="outline"
                    size="default"
                    onClick={handleBulkRerunMetadata}
                    disabled={loadingRepoIds.size > 0}
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Re-run Metadata ({actionCounts.rerunMetadata})
                  </Button>
                )}
                
                {availableActions.includes('retry') && (
                  <Button
                    variant="outline"
                    size="default"
                    onClick={handleBulkRetry}
                    disabled={loadingRepoIds.size > 0}
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Retry
                  </Button>
                )}
                
                {availableActions.includes('ignore') && (
                  <Button
                    variant="ghost"
                    size="default"
                    onClick={() => handleBulkSkip(true)}
                    disabled={loadingRepoIds.size > 0}
                  >
                    <Ban className="h-4 w-4 mr-2" />
                    Ignore
                  </Button>
                )}
                
                {availableActions.includes('include') && (
                  <Button
                    variant="outline"
                    size="default"
                    onClick={() => handleBulkSkip(false)}
                    disabled={loadingRepoIds.size > 0}
                  >
                    <Check className="h-4 w-4 mr-2" />
                    Include
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Action buttons for mobile - only show when items are selected */}
      {selectedRepoIds.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap sm:hidden">
          <div className="flex items-center gap-2 px-3 py-1 bg-muted/50 rounded-md">
              <span className="text-sm font-medium">
                {selectedRepoIds.size} selected
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setSelectedRepoIds(new Set())}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            
            <div className="flex gap-2 flex-wrap">
              {availableActions.includes('mirror') && (
            <Button
              variant="default"
              size="sm"
              onClick={handleBulkMirror}
              disabled={loadingRepoIds.size > 0}
            >
              <FlipHorizontal className="h-4 w-4 mr-2" />
              <span>Mirror </span>({actionCounts.mirror})
            </Button>
          )}
          
          {availableActions.includes('sync') && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleBulkSync}
              disabled={loadingRepoIds.size > 0}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              <span className="hidden sm:inline">Sync </span>({actionCounts.sync})
            </Button>
          )}

          {availableActions.includes('rerun-metadata') && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleBulkRerunMetadata}
              disabled={loadingRepoIds.size > 0}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Re-run Metadata ({actionCounts.rerunMetadata})
            </Button>
          )}
          
          {availableActions.includes('retry') && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleBulkRetry}
              disabled={loadingRepoIds.size > 0}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          )}
          
          {availableActions.includes('ignore') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleBulkSkip(true)}
              disabled={loadingRepoIds.size > 0}
            >
              <Ban className="h-4 w-4 mr-2" />
              Ignore
            </Button>
          )}
          
          {availableActions.includes('include') && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleBulkSkip(false)}
              disabled={loadingRepoIds.size > 0}
            >
              <Check className="h-4 w-4 mr-2" />
              Include
            </Button>
          )}
          </div>
        </div>
      )}

      {!isGitHubConfigured ? (
        <div className="flex flex-col items-center justify-center p-8 border border-dashed rounded-md">
          <h3 className="text-xl font-semibold mb-2">GitHub Not Configured</h3>
          <p className="text-muted-foreground text-center mb-4">
            You need to configure your GitHub credentials before you can fetch and mirror repositories.
          </p>
          <Button
            variant="default"
            onClick={() => {
              window.history.pushState({}, '', '/config');
              // We need to trigger a page change event for the navigation system
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
          >
            Go to Configuration
          </Button>
        </div>
      ) : (
        <RepositoryTable
          repositories={repositories}
          isLoading={isInitialLoading || !connected}
          isLiveActive={isLiveEnabled && isFullyConfigured}
          filter={filter}
          setFilter={setFilter}
          onMirror={handleMirrorRepo}
          onSync={handleSyncRepo}
          onRetry={handleRetryRepoAction}
          onSkip={handleSkipRepo}
          loadingRepoIds={loadingRepoIds}
          selectedRepoIds={selectedRepoIds}
          onSelectionChange={setSelectedRepoIds}
          onRefresh={async () => {
            await fetchRepositories(false);
          }}
          onDelete={handleRequestDeleteRepository}
        />
      )}

      <AddRepositoryDialog
        onAddRepository={handleAddRepository}
        isDialogOpen={isDialogOpen}
        setIsDialogOpen={setIsDialogOpen}
      />

      <Dialog
        open={isDuplicateRepoDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            handleCancelDuplicateRepository();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Repository already exists</DialogTitle>
            <DialogDescription>
              {duplicateRepoCandidate ? `${duplicateRepoCandidate.owner}/${duplicateRepoCandidate.repo}` : "This repository"} is already tracked in Gitea Mirror. Continuing will refresh the existing entry without creating a duplicate.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelDuplicateRepository} disabled={isProcessingDuplicateRepo}>
              Cancel
            </Button>
            <Button onClick={handleConfirmDuplicateRepository} disabled={isProcessingDuplicateRepo}>
              {isProcessingDuplicateRepo ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                "Continue"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isDeleteRepoDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsDeleteRepoDialogOpen(false);
            setRepoToDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove repository from Gitea Mirror?</DialogTitle>
            <DialogDescription>
              {repoToDelete?.fullName ?? "This repository"} will be deleted from Gitea Mirror only. The mirror on Gitea will remain untouched; remove it manually in Gitea if needed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsDeleteRepoDialogOpen(false);
                setRepoToDelete(null);
              }}
              disabled={isDeletingRepo}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteRepository} disabled={isDeletingRepo}>
              {isDeletingRepo ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <span className="flex items-center gap-2">
                  <Trash2 className="h-4 w-4" />
                  Delete
                </span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
