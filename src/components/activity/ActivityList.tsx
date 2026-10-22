import { useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MirrorJob } from '@/lib/db/schema';
import { Button } from '../ui/button';
import {
  RefreshCw,
  Check,
  X,
  Loader2,
  Import,
  Activity as ActivityIcon,
  Building2,
  ChevronDown,
  GitFork,
  TriangleAlert,
} from 'lucide-react';
import { Card } from '../ui/card';
import { cn, formatDate, formatLastSyncTime } from '@/lib/utils';
import { useTimeFormat } from '@/hooks/useTimeFormat';
import { Skeleton } from '../ui/skeleton';
import type { FilterParams } from '@/types/filter';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';

/** How each status presents itself. Previously this was a chain of ternaries
 *  written out twice, once for mobile and once for desktop. */
export const STATUS_PRESENTATION: Record<
  string,
  {
    Icon: typeof Check;
    label: string;
    /** One word, for the stat chips. */
    short: string;
    tone: string;
    wash: string;
    spin?: boolean;
  }
> = {
  synced: {
    Icon: Check,
    label: 'Sync successful',
    short: 'synced',
    tone: 'text-teal-600 dark:text-teal-400',
    wash: 'bg-teal-500/10',
  },
  mirrored: {
    Icon: Check,
    label: 'Mirror successful',
    short: 'mirrored',
    tone: 'text-emerald-600 dark:text-emerald-400',
    wash: 'bg-emerald-500/10',
  },
  failed: {
    Icon: X,
    label: 'Operation failed',
    short: 'failed',
    tone: 'text-rose-600 dark:text-rose-400',
    wash: 'bg-rose-500/10',
  },
  syncing: {
    Icon: Loader2,
    label: 'Syncing in progress',
    short: 'syncing',
    tone: 'text-indigo-600 dark:text-indigo-400',
    wash: 'bg-indigo-500/10',
    spin: true,
  },
  mirroring: {
    Icon: Loader2,
    label: 'Mirroring in progress',
    short: 'mirroring',
    tone: 'text-yellow-600 dark:text-yellow-400',
    wash: 'bg-yellow-500/10',
    spin: true,
  },
  imported: {
    Icon: Import,
    label: 'Imported',
    short: 'imported',
    tone: 'text-blue-600 dark:text-blue-400',
    wash: 'bg-blue-500/10',
  },
  warning: {
    Icon: TriangleAlert,
    label: 'Configuration warning',
    short: 'warning',
    tone: 'text-amber-600 dark:text-amber-400',
    wash: 'bg-amber-500/10',
  },
};

const FALLBACK_PRESENTATION = {
  Icon: ActivityIcon,
  label: '',
  short: '',
  tone: 'text-foreground',
  wash: 'bg-muted',
  spin: false,
};

type MirrorJobWithKey = MirrorJob & { _rowKey: string };
/**
 * One activity row. Follows the dashboard's Recent Activity shape (status
 * circle, message, time) but uses the extra width here to also carry the
 * repository or organization it belongs to and the raw message, with the
 * details pane opening in place.
 */
function RowBody({
  activity,
  isExpanded,
  onToggle,
}: {
  activity: MirrorJobWithKey;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const presentation =
    STATUS_PRESENTATION[activity.status] ?? FALLBACK_PRESENTATION;
  const { Icon, tone, wash, spin } = presentation;
  // Unknown statuses have no label of their own, so the message stands in.
  const label = presentation.label || activity.message;
  const name = activity.repositoryName || activity.organizationName;
  const NameIcon = activity.repositoryName ? GitFork : Building2;
  const hasDetails = !!activity.details;
  // The label already says what happened; repeating it below is noise.
  const showMessage = activity.message && activity.message !== label;

  const content = (
    <div className='flex w-full items-start gap-3 px-4 py-3 text-left'>
      <span
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          wash,
        )}
      >
        <Icon className={cn('h-4 w-4', tone, spin && 'animate-spin')} />
      </span>

      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          <span className={cn('text-sm font-medium', tone)}>{label}</span>
          {name && (
            <span className='flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground'>
              <NameIcon className='h-3 w-3 shrink-0' />
              <span className='truncate font-mono'>{name}</span>
            </span>
          )}
        </div>

        {showMessage && (
          <p className='mt-1 truncate text-[13px] text-muted-foreground'>
            {activity.message}
          </p>
        )}
      </div>

      <div className='flex shrink-0 items-center gap-2'>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className='cursor-help text-xs text-muted-foreground'>
                {formatLastSyncTime(activity.timestamp)}
              </span>
            </TooltipTrigger>
            <TooltipContent side='left'>
              {formatDate(activity.timestamp)}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {hasDetails && (
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform',
              isExpanded && 'rotate-180',
            )}
          />
        )}
      </div>
    </div>
  );

  return (
    <>
      {hasDetails ? (
        <button
          type='button'
          onClick={onToggle}
          aria-expanded={isExpanded}
          className='w-full cursor-pointer transition-colors hover:bg-muted/50'
        >
          {content}
        </button>
      ) : (
        content
      )}

      {isExpanded && activity.details && (
        <pre className='mx-4 mb-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs'>
          {activity.details}
        </pre>
      )}
    </>
  );
}


interface ActivityListProps {
  /** Already filtered by ActivityLog. */
  activities: MirrorJobWithKey[];
  isLoading: boolean;
  filter: FilterParams;
  setFilter: (filter: FilterParams) => void;
  className?: string;
}

export default function ActivityList({
  activities,
  isLoading,
  filter,
  setFilter,
  className,
}: ActivityListProps) {
  // Re-render timestamps when the user changes the 12h/24h preference.
  useTimeFormat();

  const [expandedItems, setExpandedItems] = useState<Set<string>>(
    () => new Set(),
  );

  const parentRef = useRef<HTMLDivElement>(null);
  // Kept so a toggled row can be re-measured against its real height.
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const virtualizer = useVirtualizer({
    count: activities.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (idx) =>
      expandedItems.has(activities[idx]._rowKey) ? 200 : 69,
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Expanding a row changes its height. Re-measure the mounted rows rather
  // than calling virtualizer.measure(), which throws away every measurement
  // and drops all rows back to estimateSize.
  useLayoutEffect(() => {
    rowRefs.current.forEach((node) => {
      if (node) virtualizer.measureElement(node);
    });
  }, [expandedItems, virtualizer]);

  /* ------------------------------ render ------------------------------ */

  if (isLoading) {
    return (
      <div className={cn('flex flex-col gap-y-4', className)}>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className='h-28 w-full rounded-md' />
        ))}
      </div>
    );
  }

  if (activities.length === 0) {
    const hasFilter =
      filter.searchTerm || filter.status || filter.type || filter.name;

    return (
      <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
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
    <div className={cn("flex min-h-0 flex-col border rounded-md", className)}>
      <Card
        ref={parentRef}
        className='relative min-h-0 flex-1 overflow-y-auto rounded-none border-0'
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualizer.getVirtualItems().map((vRow) => {
          const activity = activities[vRow.index];
          const isExpanded = expandedItems.has(activity._rowKey);

          return (
            <div
              key={activity._rowKey}
              // measureElement reads the row index off this attribute; without
              // it the measurement is dropped and rows keep their estimate.
              data-index={vRow.index}
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
              }}
              className='border-b'
            >
              <RowBody
                activity={activity}
                isExpanded={isExpanded}
                onToggle={() =>
                  setExpandedItems((prev) => {
                    const next = new Set(prev);
                    next.has(activity._rowKey)
                      ? next.delete(activity._rowKey)
                      : next.add(activity._rowKey);
                    return next;
                  })
                }
              />
            </div>
          );
        })}
      </div>
    </Card>
  </div>
  );
}
