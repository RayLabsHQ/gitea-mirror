import { useCallback, useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronDown, Download, RefreshCw, Search, Trash2, Filter } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import { apiRequest, formatDate, showErrorToast } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { MirrorJob } from '@/lib/db/schema';
import type { ActivityApiResponse } from '@/types/activities';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { repoStatusEnum, type RepoStatus } from '@/types/Repository';
import ActivityList from './ActivityList';
import { ActivityNameCombobox } from './ActivityNameCombobox';
import { useSSE } from '@/hooks/useSEE';
import { useFilterParams } from '@/hooks/useFilterParams';
import { toast } from 'sonner';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useConfigStatus } from '@/hooks/useConfigStatus';
import { useNavigation } from '@/components/layout/MainLayout';
import { withBase } from '@/lib/base-path';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';

type MirrorJobWithKey = MirrorJob & { _rowKey: string };

// Maximum number of activities to keep in memory to prevent performance issues
const MAX_ACTIVITIES = 1000;

// More robust key generation to prevent collisions
function genKey(job: MirrorJob, index?: number): string {
  const baseId = job.id || `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const timestamp = job.timestamp instanceof Date ? job.timestamp.getTime() : new Date(job.timestamp).getTime();
  const indexSuffix = index !== undefined ? `-${index}` : '';
  return `${baseId}-${timestamp}${indexSuffix}`;
}

// Create a deep clone without structuredClone for better browser compatibility
function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime()) as T;
  if (Array.isArray(obj)) return obj.map(item => deepClone(item)) as T;

  const cloned = {} as T;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  return cloned;
}

export function ActivityLog() {
  const { user } = useAuth();
  const { registerRefreshCallback, isLiveEnabled } = useLiveRefresh();
  const { isFullyConfigured } = useConfigStatus();
  const { navigationKey } = useNavigation();

  const [activities, setActivities] = useState<MirrorJobWithKey[]>([]);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [showCleanupDialog, setShowCleanupDialog] = useState(false);

  // Ref to track if component is mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const { filter, setFilter } = useFilterParams({
    searchTerm: '',
    status: '',
    type: '',
    name: '',
  });

  /* ----------------------------- SSE hook ----------------------------- */

  const handleNewMessage = useCallback((data: MirrorJob) => {
    if (!isMountedRef.current) return;

    setActivities((prev) => {
      // Create a deep clone of the new activity
      const clonedData = deepClone(data);

      // Check if this activity already exists to prevent duplicates
      const existingIndex = prev.findIndex(activity =>
        activity.id === clonedData.id ||
        (activity.repositoryId === clonedData.repositoryId &&
         activity.organizationId === clonedData.organizationId &&
         activity.message === clonedData.message &&
         Math.abs(new Date(activity.timestamp).getTime() - new Date(clonedData.timestamp).getTime()) < 1000)
      );

      if (existingIndex !== -1) {
        // Update existing activity instead of adding duplicate
        const updated = [...prev];
        updated[existingIndex] = {
          ...clonedData,
          _rowKey: prev[existingIndex]._rowKey, // Keep the same key
        };
        return updated;
      }

      // Add new activity with unique key
      const withKey: MirrorJobWithKey = {
        ...clonedData,
        _rowKey: genKey(clonedData, prev.length),
      };

      // Limit the number of activities to prevent memory issues
      const newActivities = [withKey, ...prev];
      return newActivities.slice(0, MAX_ACTIVITIES);
    });
  }, []);

  const { connected } = useSSE({
    userId: user?.id,
    onMessage: handleNewMessage,
  });

  /* ------------------------- initial fetch --------------------------- */

  const fetchActivities = useCallback(async (isLiveRefresh = false) => {
    if (!user?.id) return false;

    try {
      // Set appropriate loading state based on refresh type
      if (!isLiveRefresh) {
        setIsInitialLoading(true);
      }

      const res = await apiRequest<ActivityApiResponse>(
        `/activities?userId=${user.id}`,
        { method: 'GET' },
      );

      if (!res.success) {
        // Only show error toast for manual refreshes to avoid spam during live updates
        if (!isLiveRefresh) {
          showErrorToast(res.message ?? 'Failed to fetch activities.', toast);
        }
        return false;
      }

      // Process activities with robust cloning and unique keys
      const data: MirrorJobWithKey[] = res.activities.map((activity, index) => {
        const clonedActivity = deepClone(activity);
        return {
          ...clonedActivity,
          _rowKey: genKey(clonedActivity, index),
        };
      });

      // Sort by timestamp (newest first) to ensure consistent ordering
      data.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeB - timeA;
      });

      if (isMountedRef.current) {
        setActivities(data);
      }
      return true;
    } catch (err) {
      if (isMountedRef.current) {
        // Only show error toast for manual refreshes to avoid spam during live updates
        if (!isLiveRefresh) {
          showErrorToast(err, toast);
        }
      }
      return false;
    } finally {
      if (isMountedRef.current && !isLiveRefresh) {
        setIsInitialLoading(false);
      }
    }
  }, [user?.id]); // Only depend on user.id, not entire user object

  useEffect(() => {
    // Reset loading state when component becomes active
    setIsInitialLoading(true);
    fetchActivities(false); // Manual refresh, not live
  }, [fetchActivities, navigationKey]); // Include navigationKey to trigger on navigation

  // Register with global live refresh system
  useEffect(() => {
    // Only register for live refresh if configuration is complete
    // Activity logs can exist from previous runs, but new activities won't be generated without config
    if (!isFullyConfigured) {
      return;
    }

    const unregister = registerRefreshCallback(() => {
      fetchActivities(true); // Live refresh
    });

    return unregister;
  }, [registerRefreshCallback, fetchActivities, isFullyConfigured]);

  /* ---------------------- filtering + exporting ---------------------- */

  const applyLightFilter = (list: MirrorJobWithKey[]) => {
    return list.filter((a) => {
      if (filter.status && a.status !== filter.status) return false;

      if (filter.type === 'repository' && !a.repositoryId) return false;
      if (filter.type === 'organization' && !a.organizationId) return false;

      if (
        filter.name &&
        a.repositoryName !== filter.name &&
        a.organizationName !== filter.name
      ) {
        return false;
      }

      return true;
    });
  };

  const exportAsCSV = () => {
    const rows = applyLightFilter(activities);
    if (!rows.length) return toast.error('No activities to export.');

    const headers = [
      'Timestamp',
      'Message',
      'Status',
      'Repository',
      'Organization',
      'Details',
    ];

    const escape = (v: string | null | undefined) =>
      v && /[,\"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v ?? '';

    const csv = [
      headers.join(','),
      ...rows.map((a) =>
        [
          formatDate(a.timestamp),
          escape(a.message),
          a.status,
          escape(a.repositoryName),
          escape(a.organizationName),
          escape(a.details),
        ].join(','),
      ),
    ].join('\n');

    downloadFile(csv, 'text/csv;charset=utf-8;', 'activity_log_export.csv');
    toast.success('CSV exported.');
  };

  const exportAsJSON = () => {
    const rows = applyLightFilter(activities);
    if (!rows.length) return toast.error('No activities to export.');

    const json = JSON.stringify(
      rows.map((a) => ({
        ...a,
        formattedTime: formatDate(a.timestamp),
      })),
      null,
      2,
    );

    downloadFile(json, 'application/json', 'activity_log_export.json');
    toast.success('JSON exported.');
  };

  const downloadFile = (
    content: string,
    mime: string,
    filename: string,
  ): void => {
    const date = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content], { type: mime }));
    link.download = filename.replace('.', `_${date}.`);
    link.click();
  };

  const handleCleanupClick = () => {
    setShowCleanupDialog(true);
  };

  const confirmCleanup = async () => {
    if (!user?.id) return;

    try {
      setIsInitialLoading(true);
      setShowCleanupDialog(false);

      const response = await fetch(withBase('/api/activities/cleanup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error occurred' }));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      const res = await response.json();

      if (res.success) {
        // Clear the activities from the UI
        setActivities([]);
        toast.success(`All activities cleaned up successfully. Deleted ${res.result.mirrorJobsDeleted} mirror jobs and ${res.result.eventsDeleted} events.`);
      } else {
        showErrorToast(res.error || 'Failed to cleanup activities.', toast);
      }
    } catch (error) {
      console.error('Error cleaning up activities:', error);
      showErrorToast(error, toast);
    } finally {
      setIsInitialLoading(false);
    }
  };

  const cancelCleanup = () => {
    setShowCleanupDialog(false);
  };

  // Check if any filters are active
  const hasActiveFilters = !!(filter.status || filter.type || filter.name);
  const activeFilterCount = [filter.status, filter.type, filter.name].filter(Boolean).length;

  // Clear all filters
  const clearFilters = () => {
    setFilter({
      searchTerm: filter.searchTerm,
      status: '',
      type: '',
      name: '',
    });
  };

  /* ------------------------------ UI ------------------------------ */

  return (
    <div className='flex flex-col gap-y-4 sm:gap-y-8'>
      {/* Mobile: Search bar with filter and action buttons */}
      <div className="flex flex-col gap-2 sm:hidden">
        <div className="flex items-center gap-2 w-full">
          <div className="relative flex-grow">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search activities..."
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
                <DrawerTitle className="text-lg font-semibold">Filter Activities</DrawerTitle>
                <DrawerDescription className="text-sm text-muted-foreground">
                  Narrow down your activity log
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
                    value={filter.status || 'all'}
                    onValueChange={(v) =>
                      setFilter((p) => ({
                        ...p,
                        status: v === 'all' ? '' : (v as RepoStatus),
                      }))
                    }
                  >
                    <SelectTrigger className="w-full h-10">
                      <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      {['all', ...repoStatusEnum.options].map((s) => (
                        <SelectItem key={s} value={s}>
                          <span className="flex items-center gap-2">
                            {s !== 'all' && (
                              <span className={`h-2 w-2 rounded-full ${
                                s === 'synced' ? 'bg-green-500' :
                                s === 'failed' ? 'bg-red-500' :
                                s === 'syncing' ? 'bg-blue-500' :
                                'bg-yellow-500'
                              }`} />
                            )}
                            {s === 'all' ? 'All statuses' : s[0].toUpperCase() + s.slice(1)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Type Filter */}
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-2">
                    <span className="text-muted-foreground">By</span> Type
                    {filter.type && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {filter.type.charAt(0).toUpperCase() + filter.type.slice(1)}
                      </span>
                    )}
                  </label>
                  <Select
                    value={filter.type || 'all'}
                    onValueChange={(v) =>
                      setFilter((p) => ({ ...p, type: v === 'all' ? '' : v }))
                    }
                  >
                    <SelectTrigger className="w-full h-10">
                      <SelectValue placeholder="All types" />
                    </SelectTrigger>
                    <SelectContent>
                      {['all', 'repository', 'organization'].map((t) => (
                        <SelectItem key={t} value={t}>
                          <span className="flex items-center gap-2">
                            {t !== 'all' && (
                              <span className={`h-2 w-2 rounded-full ${
                                t === 'repository' ? 'bg-blue-500' : 'bg-purple-500'
                              }`} />
                            )}
                            {t === 'all' ? 'All types' : t[0].toUpperCase() + t.slice(1)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Name Filter */}
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-2">
                    <span className="text-muted-foreground">By</span> Name
                    {filter.name && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        Selected
                      </span>
                    )}
                  </label>
                  <ActivityNameCombobox
                    activities={activities}
                    value={filter.name || ''}
                    onChange={(name) => setFilter((p) => ({ ...p, name }))}
                  />
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
            onClick={() => fetchActivities(false)}
            title="Refresh activity log"
            className="h-10 w-10 shrink-0"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          
          <Button
            variant="outline"
            size="icon"
            onClick={handleCleanupClick}
            title="Delete all activities"
            className="text-destructive hover:text-destructive h-10 w-10 shrink-0"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Desktop: Original layout */}
      <div className="hidden sm:flex sm:flex-row sm:items-center sm:gap-4 sm:w-full">
        {/* search input */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search activities..."
            className="pl-10 pr-3 h-10 w-full rounded-md border border-input bg-background text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={filter.searchTerm}
            onChange={(e) =>
              setFilter((prev) => ({
                ...prev,
                searchTerm: e.target.value,
              }))
            }
          />
        </div>

        {/* Filter controls */}
        <div className="flex items-center gap-2">
          {/* status select */}
          <Select
            value={filter.status || 'all'}
            onValueChange={(v) =>
              setFilter((p) => ({
                ...p,
                status: v === 'all' ? '' : (v as RepoStatus),
              }))
            }
          >
            <SelectTrigger className="w-[140px] h-10">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {['all', ...repoStatusEnum.options].map((s) => (
                <SelectItem key={s} value={s}>
                  <span className="flex items-center gap-2">
                    {s !== 'all' && (
                      <span className={`h-2 w-2 rounded-full ${
                        s === 'synced' ? 'bg-green-500' :
                        s === 'failed' ? 'bg-red-500' :
                        s === 'syncing' ? 'bg-blue-500' :
                        'bg-yellow-500'
                      }`} />
                    )}
                    {s === 'all' ? 'All statuses' : s[0].toUpperCase() + s.slice(1)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* type select */}
          <Select
            value={filter.type || 'all'}
            onValueChange={(v) =>
              setFilter((p) => ({ ...p, type: v === 'all' ? '' : v }))
            }
          >
            <SelectTrigger className="w-[140px] h-10">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              {['all', 'repository', 'organization'].map((t) => (
                <SelectItem key={t} value={t}>
                  <span className="flex items-center gap-2">
                    {t !== 'all' && (
                      <span className={`h-2 w-2 rounded-full ${
                        t === 'repository' ? 'bg-blue-500' : 'bg-purple-500'
                      }`} />
                    )}
                    {t === 'all' ? 'All types' : t[0].toUpperCase() + t.slice(1)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* repo/org name combobox */}
        <ActivityNameCombobox
          activities={activities}
          value={filter.name || ''}
          onChange={(name) => setFilter((p) => ({ ...p, name }))}
        />

        {/* Action buttons */}
        <div className="flex items-center gap-2 ml-auto">
          {/* export dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-10">
                <Download className="h-4 w-4 mr-2" />
                Export
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={exportAsCSV}>
                Export as CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={exportAsJSON}>
                Export as JSON
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* refresh */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => fetchActivities(false)}
            title="Refresh activity log"
            className="h-10 w-10"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>

          {/* cleanup all activities */}
          <Button
            variant="outline"
            size="icon"
            onClick={handleCleanupClick}
            title="Delete all activities"
            className="text-destructive hover:text-destructive h-10 w-10"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* activity list */}
      <ActivityList
        activities={applyLightFilter(activities)}
        isLoading={isInitialLoading || !connected}
        isLiveActive={isLiveEnabled && isFullyConfigured}
        filter={filter}
        setFilter={setFilter}
      />

      {/* cleanup confirmation dialog */}
      <Dialog open={showCleanupDialog} onOpenChange={setShowCleanupDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete All Activities</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete ALL activities? This action cannot be undone and will remove all mirror jobs and events from the database.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancelCleanup}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmCleanup}
              disabled={isInitialLoading}
            >
              {isInitialLoading ? 'Deleting...' : 'Delete All Activities'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mobile FAB for Export - only visible on mobile */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button 
            className="fixed bottom-4 right-4 rounded-full h-12 w-12 shadow-lg p-0 z-10 sm:hidden"
            variant="default"
          >
            <Download className="h-6 w-6" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="mb-2">
          <DropdownMenuItem onClick={exportAsCSV}>
            Export as CSV
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportAsJSON}>
            Export as JSON
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
