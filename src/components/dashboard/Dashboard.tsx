import { StatusCard } from "./StatusCard";
import { RecentActivity } from "./RecentActivity";
import { RepositoryList } from "./RepositoryList";
import { GitFork, Clock, FlipHorizontal, Building2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MirrorJob, Organization, Repository } from "@/lib/db/schema";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, showErrorToast } from "@/lib/utils";
import type { DashboardApiResponse } from "@/types/dashboard";
import { useSSE } from "@/hooks/useSEE";
import { toast } from "sonner";
import { useEffect as useEffectForToasts } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import { usePageVisibility } from "@/hooks/usePageVisibility";
import { useConfigStatus } from "@/hooks/useConfigStatus";
import { useNavigation } from "@/components/layout/MainLayout";
import { withBase } from "@/lib/base-path";

// Helper function to format last sync time
function formatLastSyncTime(date: Date | null): string {
  if (!date) return "Never";
  
  const now = new Date();
  const syncDate = new Date(date);
  const diffMs = now.getTime() - syncDate.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  // Show relative time for recent syncs
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hr${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  
  // For older syncs, show week count
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 4) return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`;
  
  // For even older, show month count
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
}

// Helper function to format full timestamp
function formatFullTimestamp(date: Date | null): string {
  if (!date) return "";
  
  return new Date(date).toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).replace(',', '');
}

export function Dashboard() {
  const { user } = useAuth();
  const { registerRefreshCallback } = useLiveRefresh();
  const isPageVisible = usePageVisibility();
  const { isFullyConfigured } = useConfigStatus();
  const { navigationKey } = useNavigation();

  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activities, setActivities] = useState<MirrorJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [repoCount, setRepoCount] = useState<number>(0);
  const [orgCount, setOrgCount] = useState<number>(0);
  const [mirroredCount, setMirroredCount] = useState<number>(0);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  // Dashboard auto-refresh timer (30 seconds)
  const dashboardTimerRef = useRef<NodeJS.Timeout | null>(null);
  const DASHBOARD_REFRESH_INTERVAL = 30000; // 30 seconds

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
    } else if (data.organizationId) {
      setOrganizations((prevOrgs) =>
        prevOrgs.map((org) =>
          org.id === data.organizationId
            ? { ...org, status: data.status, details: data.details }
            : org
        )
      );
    }

    setActivities((prevActivities) => [data, ...prevActivities]);
  }, []);

  // Use the SSE hook
  const { connected } = useSSE({
    userId: user?.id,
    onMessage: handleNewMessage,
  });

  // Setup rate limit event listener for toast notifications
  useEffectForToasts(() => {
    if (!user?.id) return;

    const eventSource = new EventSource(`${withBase("/api/events")}?userId=${user.id}`);
    
    eventSource.addEventListener("rate-limit", (event) => {
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case "warning":
            // 80% threshold warning
            toast.warning("GitHub API Rate Limit Warning", {
              description: data.message,
              duration: 8000,
            });
            break;
            
          case "exceeded":
            // 100% rate limit exceeded
            toast.error("GitHub API Rate Limit Exceeded", {
              description: data.message,
              duration: 10000,
            });
            break;
            
          case "resumed":
            // Rate limit reset notification
            toast.success("Rate Limit Reset", {
              description: "API operations have resumed.",
              duration: 5000,
            });
            break;
        }
      } catch (error) {
        console.error("Error parsing rate limit event:", error);
      }
    });

    return () => {
      eventSource.close();
    };
  }, [user?.id]);

  // Extract fetchDashboardData as a stable callback
  const fetchDashboardData = useCallback(async (showToast = false) => {
    try {
      if (!user?.id) {
        return false;
      }

      // Don't fetch data if configuration is not complete
      if (!isFullyConfigured) {
        if (showToast) {
          toast.info("Please configure GitHub and Gitea settings first");
        }
        return false;
      }

      const response = await apiRequest<DashboardApiResponse>(
        `/dashboard?userId=${user.id}`,
        {
          method: "GET",
        }
      );

      if (response.success) {
        setRepositories(response.repositories);
        setOrganizations(response.organizations);
        setActivities(response.activities);
        setRepoCount(response.repoCount);
        setOrgCount(response.orgCount);
        setMirroredCount(response.mirroredCount);
        setLastSync(response.lastSync);

        if (showToast) {
          toast.success("Dashboard data refreshed successfully");
        }
        return true;
      } else {
        showErrorToast(response.error || "Error fetching dashboard data", toast);
        return false;
      }
    } catch (error) {
      showErrorToast(error, toast);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user?.id, isFullyConfigured]); // Only depend on user.id, not entire user object

  // Initial data fetch and reset loading state when component becomes active
  useEffect(() => {
    // Reset loading state when component mounts or becomes active
    setIsLoading(true);
    fetchDashboardData();
  }, [fetchDashboardData, navigationKey]); // Include navigationKey to trigger on navigation

  // Setup dashboard auto-refresh (30 seconds) and register with live refresh
  useEffect(() => {
    // Clear any existing timer
    if (dashboardTimerRef.current) {
      clearInterval(dashboardTimerRef.current);
      dashboardTimerRef.current = null;
    }

    // Set up 30-second auto-refresh only when page is visible and configuration is complete
    if (isPageVisible && isFullyConfigured) {
      dashboardTimerRef.current = setInterval(() => {
        fetchDashboardData();
      }, DASHBOARD_REFRESH_INTERVAL);
    }

    // Cleanup on unmount or when page becomes invisible
    return () => {
      if (dashboardTimerRef.current) {
        clearInterval(dashboardTimerRef.current);
        dashboardTimerRef.current = null;
      }
    };
  }, [isPageVisible, isFullyConfigured, fetchDashboardData]);

  // Register with global live refresh system
  useEffect(() => {
    // Only register if configuration is complete
    if (!isFullyConfigured) {
      return;
    }

    const unregister = registerRefreshCallback(() => {
      fetchDashboardData();
    });

    return unregister;
  }, [registerRefreshCallback, fetchDashboardData, isFullyConfigured]);

  // Status Card Skeleton component
  function StatusCardSkeleton() {
    return (
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium">
            <Skeleton className="h-4 w-24" />
          </CardTitle>
          <Skeleton className="h-4 w-4 rounded-full" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-16 mb-1" />
          <Skeleton className="h-3 w-32" />
        </CardContent>
      </Card>
    );
  }

  return isLoading || !connected ? (
    <div className="flex flex-col gap-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-6">
        <StatusCardSkeleton />
        <StatusCardSkeleton />
        <StatusCardSkeleton />
        <StatusCardSkeleton />
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Repository List Skeleton */}
        <div className="w-full lg:w-1/2 border rounded-lg p-4">
          <div className="flex justify-between items-center mb-4">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-9 w-24" />
          </div>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        </div>

        {/* Recent Activity Skeleton */}
        <div className="w-full lg:w-1/2 border rounded-lg p-4">
          <div className="flex justify-between items-center mb-4">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-9 w-24" />
          </div>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  ) : (
    <div className="flex flex-col gap-y-6">

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-6">
        <StatusCard
          title="Repositories"
          value={repoCount}
          icon={<GitFork className="h-4 w-4" />}
          description="Total imported repositories"
        />
        <StatusCard
          title="Mirrored"
          value={mirroredCount}
          icon={<FlipHorizontal className="h-4 w-4" />}
          description="Synced to Gitea"
        />
        <StatusCard
          title="Organizations"
          value={orgCount}
          icon={<Building2 className="h-4 w-4" />}
          description="From GitHub"
        />
        <StatusCard
          title="Last Sync"
          value={formatLastSyncTime(lastSync)}
          icon={<Clock className="h-4 w-4" />}
          description={formatFullTimestamp(lastSync)}
        />
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="w-full lg:w-1/2">
          <RepositoryList repositories={repositories.slice(0, 8)} />
        </div>

        <div className="w-full lg:w-1/2">
          <RecentActivity activities={activities.slice(0, 8)} />
        </div>
      </div>
    </div>
  );
}
