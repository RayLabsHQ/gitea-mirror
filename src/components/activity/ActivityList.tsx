import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MirrorJob } from '@/lib/db/schema';
import Fuse from 'fuse.js';
import { Button } from '../ui/button';
import { RefreshCw, Check, X, Loader2, Import } from 'lucide-react';
import { Card } from '../ui/card';
import { formatDate, getStatusColor } from '@/lib/utils';
import { useTimeFormat } from '@/hooks/useTimeFormat';
import { Skeleton } from '../ui/skeleton';
import type { FilterParams } from '@/types/filter';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';

type MirrorJobWithKey = MirrorJob & { _rowKey: string };

interface ActivityListProps {
  activities: MirrorJobWithKey[];
  isLoading: boolean;
  isLiveActive?: boolean;
  filter: FilterParams;
  setFilter: (filter: FilterParams) => void;
}

export default function ActivityList({
  activities,
  isLoading,
  isLiveActive = false,
  filter,
  setFilter,
}: ActivityListProps) {
  // Re-render timestamps when the user changes the 12h/24h preference.
  useTimeFormat();

  const [expandedItems, setExpandedItems] = useState<Set<string>>(
    () => new Set(),
  );

  const parentRef = useRef<HTMLDivElement>(null);
  // We keep the ref only for possible future scroll-to-row logic.
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map()); // eslint-disable-line @typescript-eslint/no-unused-vars

  const filteredActivities = useMemo(() => {
    let result = activities;

    if (filter.status) {
      result = result.filter((a) => a.status === filter.status);
    }

    if (filter.type) {
      result =
        filter.type === 'repository'
          ? result.filter((a) => !!a.repositoryId)
          : filter.type === 'organization'
          ? result.filter((a) => !!a.organizationId)
          : result;
    }

    if (filter.name) {
      result = result.filter(
        (a) =>
          a.repositoryName === filter.name ||
          a.organizationName === filter.name,
      );
    }

    if (filter.searchTerm) {
      const fuse = new Fuse(result, {
        keys: ['message', 'details', 'organizationName', 'repositoryName'],
        threshold: 0.3,
      });
      result = fuse.search(filter.searchTerm).map((r) => r.item);
    }

    return result;
  }, [activities, filter]);

  const virtualizer = useVirtualizer({
    count: filteredActivities.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (idx) =>
      expandedItems.has(filteredActivities[idx]._rowKey) ? 217 : 100,
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height + 8,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [expandedItems, virtualizer]);

  /* ------------------------------ render ------------------------------ */

  if (isLoading) {
    return (
      <div className='flex flex-col gap-y-4'>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className='h-28 w-full rounded-md' />
        ))}
      </div>
    );
  }

  if (filteredActivities.length === 0) {
    const hasFilter =
      filter.searchTerm || filter.status || filter.type || filter.name;

    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        <RefreshCw className='mb-4 h-12 w-12 text-muted-foreground' />
        <h3 className='text-lg font-medium'>No activities found</h3>
        <p className='mt-1 mb-4 max-w-md text-sm text-muted-foreground'>
          {hasFilter
            ? 'Try adjusting your search or filter criteria.'
            : 'No mirroring activities have been recorded yet.'}
        </p>
        {hasFilter && (
          <Button
            variant='outline'
            onClick={() =>
              setFilter({ searchTerm: '', status: '', type: '', name: '' })
            }
          >
            Clear Filters
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col border rounded-md">
      <Card
        ref={parentRef}
        className='relative max-h-[calc(100dvh-231px)] overflow-y-auto rounded-none border-0'
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualizer.getVirtualItems().map((vRow) => {
          const activity = filteredActivities[vRow.index];
          const isExpanded = expandedItems.has(activity._rowKey);

          return (
            <div
              key={activity._rowKey}
              ref={(node) => {
                rowRefs.current.set(activity._rowKey, node);
                if (node) virtualizer.measureElement(node);
              }}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vRow.start}px)`,
                paddingBottom: '8px',
              }}
              className='border-b px-4 pt-4'
            >
              <div className='flex items-start gap-3 sm:gap-4'>
                <div className='relative mt-2 flex-shrink-0'>
                  <div
                    className={`h-2 w-2 rounded-full ${getStatusColor(
                      activity.status,
                    )}`}
                  />
                </div>

                <div className='flex-1 min-w-0'>
                  <div className='mb-1 flex items-start justify-between gap-2'>
                    <div className='flex-1 min-w-0'>
                      {/* Mobile: Show simplified status-based message */}
                      <div className='block sm:hidden'>
                        <p className='font-medium flex items-center gap-1.5'>
                          {activity.status === 'synced' ? (
                            <>
                              <Check className='h-4 w-4 text-teal-600 dark:text-teal-400' />
                              <span className='text-teal-600 dark:text-teal-400'>Sync successful</span>
                            </>
                          ) : activity.status === 'mirrored' ? (
                            <>
                              <Check className='h-4 w-4 text-emerald-600 dark:text-emerald-400' />
                              <span className='text-emerald-600 dark:text-emerald-400'>Mirror successful</span>
                            </>
                          ) : activity.status === 'failed' ? (
                            <>
                              <X className='h-4 w-4 text-rose-600 dark:text-rose-400' />
                              <span className='text-rose-600 dark:text-rose-400'>Operation failed</span>
                            </>
                          ) : activity.status === 'syncing' ? (
                            <>
                              <Loader2 className='h-4 w-4 text-indigo-600 dark:text-indigo-400 animate-spin' />
                              <span className='text-indigo-600 dark:text-indigo-400'>Syncing in progress</span>
                            </>
                          ) : activity.status === 'mirroring' ? (
                            <>
                              <Loader2 className='h-4 w-4 text-yellow-600 dark:text-yellow-400 animate-spin' />
                              <span className='text-yellow-600 dark:text-yellow-400'>Mirroring in progress</span>
                            </>
                          ) : activity.status === 'imported' ? (
                            <>
                              <Import className='h-4 w-4 text-blue-600 dark:text-blue-400' />
                              <span className='text-blue-600 dark:text-blue-400'>Imported</span>
                            </>
                          ) : (
                            <span>{activity.message}</span>
                          )}
                        </p>
                      </div>
                      {/* Desktop: Show status with icon and full message in tooltip */}
                      <div className='hidden sm:block'>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <p className='font-medium flex items-center gap-1.5 cursor-help'>
                                {activity.status === 'synced' ? (
                                  <>
                                    <Check className='h-4 w-4 text-teal-600 dark:text-teal-400 flex-shrink-0' />
                                    <span className='text-teal-600 dark:text-teal-400'>Sync successful</span>
                                  </>
                                ) : activity.status === 'mirrored' ? (
                                  <>
                                    <Check className='h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0' />
                                    <span className='text-emerald-600 dark:text-emerald-400'>Mirror successful</span>
                                  </>
                                ) : activity.status === 'failed' ? (
                                  <>
                                    <X className='h-4 w-4 text-rose-600 dark:text-rose-400 flex-shrink-0' />
                                    <span className='text-rose-600 dark:text-rose-400'>Operation failed</span>
                                  </>
                                ) : activity.status === 'syncing' ? (
                                  <>
                                    <Loader2 className='h-4 w-4 text-indigo-600 dark:text-indigo-400 animate-spin flex-shrink-0' />
                                    <span className='text-indigo-600 dark:text-indigo-400'>Syncing in progress</span>
                                  </>
                                ) : activity.status === 'mirroring' ? (
                                  <>
                                    <Loader2 className='h-4 w-4 text-yellow-600 dark:text-yellow-400 animate-spin flex-shrink-0' />
                                    <span className='text-yellow-600 dark:text-yellow-400'>Mirroring in progress</span>
                                  </>
                                ) : activity.status === 'imported' ? (
                                  <>
                                    <Import className='h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0' />
                                    <span className='text-blue-600 dark:text-blue-400'>Imported</span>
                                  </>
                                ) : (
                                  <span className='truncate'>{activity.message}</span>
                                )}
                              </p>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" align="start" className="max-w-[400px]">
                              <p className="whitespace-pre-wrap break-words">{activity.message}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    </div>
                    <p className='text-sm text-muted-foreground whitespace-nowrap flex-shrink-0 ml-2'>
                      {formatDate(activity.timestamp)}
                    </p>
                  </div>

                  <div className='flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3'>
                    {activity.repositoryName && (
                      <p className='text-sm text-muted-foreground truncate'>
                        <span className='font-medium'>Repo:</span> {activity.repositoryName}
                      </p>
                    )}
                    {activity.organizationName && (
                      <p className='text-sm text-muted-foreground truncate'>
                        <span className='font-medium'>Org:</span> {activity.organizationName}
                      </p>
                    )}
                  </div>

                  {activity.details && (
                    <div className='mt-2'>
                      <Button
                        variant='ghost'
                        className='h-7 px-2 text-xs'
                        onClick={() =>
                          setExpandedItems((prev) => {
                            const next = new Set(prev);
                            next.has(activity._rowKey)
                              ? next.delete(activity._rowKey)
                              : next.add(activity._rowKey);
                            return next;
                          })
                        }
                      >
                        {isExpanded ? 'Hide Details' : activity.status === 'failed' ? 'Show Error Details' : 'Show Details'}
                      </Button>

                      {isExpanded && (
                        <pre className='mt-2 min-h-[100px] whitespace-pre-wrap overflow-auto rounded-md bg-muted p-3 text-xs'>
                          {activity.details}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>

    {/* Status Bar */}
    <div className="h-[40px] flex items-center justify-between border-t bg-muted/30 px-3 relative">
      <div className="flex items-center gap-2">
        <div className={`h-1.5 w-1.5 rounded-full ${isLiveActive ? 'bg-emerald-500' : 'bg-primary'}`} />
        <span className="text-sm font-medium text-foreground">
          {filteredActivities.length} {filteredActivities.length === 1 ? 'activity' : 'activities'} total
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

      {(filter.searchTerm || filter.status || filter.type || filter.name) && (
        <span className="text-xs text-muted-foreground">
          Filters applied
        </span>
      )}
    </div>
  </div>
  );
}
