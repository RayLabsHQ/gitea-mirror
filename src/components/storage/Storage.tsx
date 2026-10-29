import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Database,
  HardDrive,
  Info,
  Package,
  RefreshCw,
  ScanSearch,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { StatusCard } from "@/components/dashboard/StatusCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/useAuth";
import { useGiteaConfig } from "@/hooks/useGiteaConfig";
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import { useNavigation } from "@/components/layout/MainLayout";
import { usePageVirtualizer } from "@/hooks/usePageVirtualizer";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { apiRequest, cn, formatLastSyncTime, showErrorToast } from "@/lib/utils";
import { buildGiteaWebUrl } from "@/lib/gitea-url";
import { formatBytes } from "@/lib/utils/format-bytes";
import type { StorageOverview, StorageRepository } from "@/lib/repository-storage";
import type { StorageRefreshProgress } from "@/lib/storage-refresh";

type StorageApiResponse =
  | ({ success: true; refresh: StorageRefreshProgress | null } & StorageOverview)
  | { success: false; error?: string };

type RefreshApiResponse = { success: true; refresh: StorageRefreshProgress } | { success: false; error?: string };

type StoragePageCache = { overview: StorageOverview; refresh: StorageRefreshProgress | null };

// While Refresh sizes runs, the page polls the overview for its progress.
const REFRESH_POLL_MS = 2000;

type SortKey = "fullName" | "owner" | "destinationSize" | "releaseAssetsSize" | "releaseAssetsCount" | "total" | "checkedAt";

const BAR_ROWS = 8;
// Repositories where release assets are at least half the space, and enough
// of it to matter, get a hint about the release limit.
const RELEASE_HEAVY_SHARE = 0.5;
const RELEASE_HEAVY_MIN_BYTES = 50 * 1024 * 1024;

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function isReleaseHeavy(repo: StorageRepository): boolean {
  const assets = repo.releaseAssetsSize ?? 0;
  return assets >= RELEASE_HEAVY_MIN_BYTES && assets >= repo.total * RELEASE_HEAVY_SHARE;
}

/** Git + LFS and release assets as one bar, scaled against the panel's largest row. */
function SplitBar({ git, assets, max }: { git: number; assets: number; max: number }) {
  const width = (value: number) => `${max > 0 ? (value / max) * 100 : 0}%`;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-indigo-500" style={{ width: width(git) }} />
      <div className="h-full bg-amber-500" style={{ width: width(assets) }} />
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-xs font-normal text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-indigo-500" />
        Git + LFS
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        Release assets
      </span>
    </div>
  );
}

interface BarRow {
  key: string;
  label: string;
  detail?: string;
  git: number;
  assets: number;
  total: number;
}

function BarPanel({ title, icon, rows }: { title: string; icon: React.ReactNode; rows: BarRow[] }) {
  const max = rows.reduce((largest, row) => Math.max(largest, row.total), 0);
  return (
    <Card className="h-full w-full">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-3 text-base font-semibold">
          {icon}
          {title}
        </CardTitle>
        <Legend />
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5">
        {rows.map((row) => (
          <div key={row.key} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium" title={row.label}>
                {row.label}
                {row.detail && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{row.detail}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(row.total)}</span>
            </div>
            <SplitBar git={row.git} assets={row.assets} max={max} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; descending: boolean };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Arrow = sort.descending ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn("flex items-center gap-1 hover:text-foreground", active ? "text-foreground" : "text-muted-foreground", className)}
    >
      {label}
      {active && <Arrow className="h-3.5 w-3.5" />}
    </button>
  );
}

function compareRepositories(a: StorageRepository, b: StorageRepository, key: SortKey): number {
  switch (key) {
    case "fullName":
      return a.fullName.localeCompare(b.fullName);
    case "owner":
      return a.owner.localeCompare(b.owner) || a.fullName.localeCompare(b.fullName);
    case "checkedAt":
      return (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "");
    default:
      return (a[key] ?? -1) - (b[key] ?? -1);
  }
}

function RefreshSizesButton({
  refresh,
  starting,
  onClick,
  className,
}: {
  refresh: StorageRefreshProgress | null;
  starting: boolean;
  onClick: () => void;
  className?: string;
}) {
  const running = !!refresh?.running;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" className={cn("h-10", className)} onClick={onClick} disabled={running || starting}>
            <RefreshCw className={cn("h-4 w-4", (running || starting) && "animate-spin")} />
            {running ? `Measuring ${refresh.done} of ${refresh.total}` : "Refresh sizes"}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Reads every mirror's size from the destination now instead of waiting for its next sync. Nothing is
          asked of the source.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function announceRefresh(progress: StorageRefreshProgress) {
  const parts = [`Measured ${progress.measured} ${progress.measured === 1 ? "repository" : "repositories"}`];
  if (progress.missing > 0) parts.push(`${progress.missing} not found on the destination`);
  if (progress.failed > 0) parts.push(`${progress.failed} could not be read and kept their sizes`);
  const message = parts.join(", ");
  if (progress.missing > 0 || progress.failed > 0) toast.warning(message);
  else toast.success(message);
}

function StorageSkeleton() {
  return (
    <div className="flex flex-col gap-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <div className="flex flex-col lg:flex-row gap-6">
        <Skeleton className="h-72 w-full lg:w-1/2 rounded-xl" />
        <Skeleton className="h-72 w-full lg:w-1/2 rounded-xl" />
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}

/**
 * Storage the mirrors take up on the destination (#479). Every number was
 * recorded by a sync from data it fetched anyway, so this page only reads the
 * database.
 */
export function Storage() {
  const { user } = useAuth();
  const { registerRefreshCallback } = useLiveRefresh();
  const { navigationKey } = useNavigation();
  const { giteaConfig } = useGiteaConfig();

  // What this page showed last time in this tab, shown again while it refreshes.
  const [cached] = useState(() => readPageCache<StoragePageCache>(user?.id, "storage"));
  const [overview, setOverview] = useState<StorageOverview | null>(cached?.overview ?? null);
  const [refresh, setRefresh] = useState<StorageRefreshProgress | null>(cached?.refresh ?? null);
  // True once there are numbers to show, from the cache or a fetch.
  const hasLoadedRef = useRef(!!cached);
  const [startingRefresh, setStartingRefresh] = useState(false);
  // Set once this page has seen a run going, so its end is announced once.
  const watchingRefreshRef = useRef(false);
  const [isLoading, setIsLoading] = useState(!cached);
  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "total", descending: true });

  const fetchOverview = useCallback(
    async (isLiveRefresh = false) => {
      if (!user?.id) return;
      try {
        const response = await apiRequest<StorageApiResponse>("/storage", { method: "GET" });
        if (response.success) {
          hasLoadedRef.current = true;
          setOverview(response);
          setRefresh(response.refresh);
          if (response.refresh?.running) {
            watchingRefreshRef.current = true;
          } else if (watchingRefreshRef.current && response.refresh) {
            watchingRefreshRef.current = false;
            announceRefresh(response.refresh);
          }
        } else if (!isLiveRefresh) {
          toast.error(response.error || "Error fetching storage");
        }
      } catch (error) {
        if (!isLiveRefresh) {
          toast.error(error instanceof Error ? error.message : "Error fetching storage");
        }
      } finally {
        if (!isLiveRefresh) setIsLoading(false);
      }
    },
    [user?.id]
  );

  useEffect(() => {
    // With numbers from the last visit on screen, refresh them in the
    // background instead of going back to the skeleton.
    const showingOverview = hasLoadedRef.current;
    if (!showingOverview) setIsLoading(true);
    fetchOverview(showingOverview);
  }, [fetchOverview, navigationKey]);

  useEffect(() => {
    if (overview) writePageCache<StoragePageCache>(user?.id, "storage", { overview, refresh });
  }, [user?.id, overview, refresh]);

  useEffect(() => registerRefreshCallback(() => fetchOverview(true)), [registerRefreshCallback, fetchOverview]);

  useEffect(() => {
    if (!refresh?.running) return;
    const timer = setInterval(() => fetchOverview(true), REFRESH_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh?.running, fetchOverview]);

  const startRefresh = async () => {
    setStartingRefresh(true);
    try {
      const response = await apiRequest<RefreshApiResponse>("/storage/refresh", { method: "POST" });
      if (response.success) {
        watchingRefreshRef.current = true;
        setRefresh(response.refresh);
      } else {
        toast.error(response.error || "Could not start Refresh sizes");
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setStartingRefresh(false);
    }
  };

  const handleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, descending: !prev.descending }
        : { key, descending: key !== "fullName" && key !== "owner" }
    );

  const visibleRepositories = useMemo(() => {
    if (!overview) return [];
    const term = search.trim().toLowerCase();
    const rows = overview.repositories.filter(
      (repo) =>
        (ownerFilter === "all" || repo.owner === ownerFilter) &&
        (!term || repo.fullName.toLowerCase().includes(term) || repo.location.toLowerCase().includes(term))
    );
    rows.sort((a, b) => {
      const order = compareRepositories(a, b, sort.key);
      return sort.descending ? -order : order;
    });
    return rows;
  }, [overview, search, ownerFilter, sort]);

  // Only the rows near the viewport are in the DOM.
  const { listRef: rowListRef, virtualizer: rowVirtualizer } = usePageVirtualizer({
    count: visibleRepositories.length,
    estimateSize: () => 53,
    getItemKey: (index) => visibleRepositories[index]?.id ?? index,
  });

  if (isLoading || !overview) return <StorageSkeleton />;

  const { totals } = overview;

  if (totals.measured === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <HardDrive className="h-10 w-10 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No sizes recorded yet</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Each sync records how much space the mirror takes on the destination, from data the sync
            already fetches. Sizes show up here after the next sync, or now with Refresh sizes, which only
            reads the destination.
          </p>
          <RefreshSizesButton refresh={refresh} starting={startingRefresh} onClick={startRefresh} className="mt-6" />
        </CardContent>
      </Card>
    );
  }

  const ownerRows: BarRow[] = overview.owners.slice(0, BAR_ROWS).map((owner) => ({
    key: owner.owner || "(unknown)",
    label: owner.owner || "Unknown owner",
    detail: `${owner.repositories} ${owner.repositories === 1 ? "repo" : "repos"}`,
    git: owner.destinationSize,
    assets: owner.releaseAssetsSize,
    total: owner.total,
  }));
  const largestRows: BarRow[] = overview.repositories.slice(0, BAR_ROWS).map((repo) => ({
    key: repo.id,
    label: repo.location || repo.fullName,
    git: repo.destinationSize ?? 0,
    assets: repo.releaseAssetsSize ?? 0,
    total: repo.total,
  }));
  const unmeasured = Math.max(0, totals.mirrored - totals.measured);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-6">
          <StatusCard
            title="Total stored"
            value={formatBytes(totals.total)}
            icon={<HardDrive className="h-4 w-4" />}
            description={`Across ${totals.measured} ${totals.measured === 1 ? "repository" : "repositories"}`}
          />
          <StatusCard
            title="Git + LFS"
            value={formatBytes(totals.destinationSize)}
            icon={<Database className="h-4 w-4" />}
            description="As the destination reports it"
          />
          <StatusCard
            title="Release assets"
            value={formatBytes(totals.releaseAssetsSize)}
            icon={<Package className="h-4 w-4" />}
            description={`${percent(totals.releaseAssetsSize, totals.total)}% of the total, ${totals.releaseAssetsCount.toLocaleString()} files`}
          />
          <StatusCard
            title="Measured"
            value={`${totals.measured} / ${totals.mirrored}`}
            icon={<ScanSearch className="h-4 w-4" />}
            description={unmeasured > 0 ? "The rest are measured on their next sync" : "Every mirror is measured"}
          />
        </div>

        <div className="flex flex-col lg:flex-row gap-6">
          <div className="w-full lg:w-1/2">
            <BarPanel title="By owner" icon={<HardDrive className="h-5 w-5 text-muted-foreground" />} rows={ownerRows} />
          </div>
          <div className="w-full lg:w-1/2">
            <BarPanel title="Largest repositories" icon={<Database className="h-5 w-5 text-muted-foreground" />} rows={largestRows} />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-grow min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search repositories..."
                className="pl-10 pr-3 h-10 w-full rounded-md border border-input bg-background text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Select value={ownerFilter} onValueChange={setOwnerFilter}>
              <SelectTrigger className="h-10 w-full sm:w-52">
                <SelectValue placeholder="All owners" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All owners</SelectItem>
                {overview.owners
                  .filter((owner) => owner.owner)
                  .map((owner) => (
                    <SelectItem key={owner.owner} value={owner.owner}>
                      {owner.owner}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <RefreshSizesButton
              refresh={refresh}
              starting={startingRefresh}
              onClick={startRefresh}
              className="w-full sm:w-auto shrink-0"
            />
          </div>

          <div className="overflow-x-auto" data-testid="storage-table">
            <div className="min-w-[56rem] border rounded-md">
              <div className="h-[45px] flex items-center border-b bg-muted/50 text-sm font-medium">
                <div className="h-full p-3 flex items-center flex-[2.4] sticky left-0 z-10 bg-background before:absolute before:inset-0 before:-z-10 before:bg-muted/50">
                  <SortHeader label="Repository" sortKey="fullName" sort={sort} onSort={handleSort} />
                </div>
                <div className="h-full p-3 flex items-center flex-[1.1]">
                  <SortHeader label="Owner" sortKey="owner" sort={sort} onSort={handleSort} />
                </div>
                <div className="h-full p-3 flex items-center justify-end flex-[1]">
                  <SortHeader label="Git + LFS" sortKey="destinationSize" sort={sort} onSort={handleSort} />
                </div>
                <div className="h-full p-3 flex items-center justify-end flex-[1.1]">
                  <SortHeader label="Release assets" sortKey="releaseAssetsSize" sort={sort} onSort={handleSort} />
                </div>
                <div className="h-full p-3 flex items-center justify-end flex-[0.7]">
                  <SortHeader label="Files" sortKey="releaseAssetsCount" sort={sort} onSort={handleSort} />
                </div>
                <div className="h-full p-3 flex items-center justify-end flex-[1]">
                  <SortHeader label="Total" sortKey="total" sort={sort} onSort={handleSort} />
                </div>
                <div className="h-full p-3 flex items-center justify-end flex-[1]">
                  <SortHeader label="Checked" sortKey="checkedAt" sort={sort} onSort={handleSort} />
                </div>
              </div>

              {visibleRepositories.length === 0 && (
                <div className="p-6 text-center text-sm text-muted-foreground">No repositories match.</div>
              )}

              <div ref={rowListRef} className="relative" style={{ height: rowVirtualizer.getTotalSize() }}>
              {rowVirtualizer.getVirtualItems().map((item) => {
                const repo = visibleRepositories[item.index];
                if (!repo) return null;
                const destinationUrl = repo.location ? buildGiteaWebUrl(giteaConfig, repo.location) : null;
                const heavy = isReleaseHeavy(repo);
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={rowVirtualizer.measureElement}
                    data-testid="storage-row"
                    className={cn(
                      "group absolute left-0 top-0 w-full min-h-[48px] flex items-center hover:bg-muted/50 text-sm",
                      item.index < visibleRepositories.length - 1 && "border-b"
                    )}
                    style={{ transform: `translateY(${item.start - rowVirtualizer.options.scrollMargin}px)` }}
                  >
                    <div className="h-full px-3 py-2 flex items-center flex-[2.4] min-w-0 sticky left-0 z-10 bg-background before:absolute before:inset-0 before:-z-10 group-hover:before:bg-muted/50">
                      <div className="min-w-0">
                        {destinationUrl ? (
                          <a
                            href={destinationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block font-medium truncate hover:underline"
                            title={`Open ${repo.location} on the destination`}
                          >
                            {repo.location}
                          </a>
                        ) : (
                          <span className="block font-medium truncate">{repo.location || repo.fullName}</span>
                        )}
                        {repo.location && repo.location !== repo.fullName && (
                          <span className="block text-xs text-muted-foreground truncate">from {repo.fullName}</span>
                        )}
                      </div>
                    </div>
                    <div className="h-full px-3 py-2 flex items-center flex-[1.1] min-w-0 text-muted-foreground truncate">
                      {repo.owner || "Unknown"}
                    </div>
                    <div className="h-full px-3 py-2 flex items-center justify-end flex-[1] tabular-nums">
                      {repo.destinationSize === null ? <span className="text-muted-foreground">-</span> : formatBytes(repo.destinationSize)}
                    </div>
                    <div className="h-full px-3 py-2 flex items-center justify-end gap-1.5 flex-[1.1] tabular-nums">
                      {heavy && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Release assets take most of this repository" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            Release assets are {percent(repo.releaseAssetsSize ?? 0, repo.total)}% of this repository. A lower
                            release limit in its Mirror options removes the oldest releases on the next sync.
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {repo.releaseAssetsSize === null ? <span className="text-muted-foreground">-</span> : formatBytes(repo.releaseAssetsSize)}
                    </div>
                    <div className="h-full px-3 py-2 flex items-center justify-end flex-[0.7] tabular-nums text-muted-foreground">
                      {repo.releaseAssetsCount === null ? "-" : repo.releaseAssetsCount.toLocaleString()}
                    </div>
                    <div className="h-full px-3 py-2 flex items-center justify-end flex-[1] tabular-nums font-medium">
                      {formatBytes(repo.total)}
                    </div>
                    <div
                      className="h-full px-3 py-2 flex items-center justify-end flex-[1] text-muted-foreground"
                      title={repo.checkedAt ? new Date(repo.checkedAt).toLocaleString() : undefined}
                    >
                      {formatLastSyncTime(repo.checkedAt)}
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Sizes are what the destination reports: Git and LFS together, plus the release assets it stores. Each sync
            records them from data it already fetches, and Refresh sizes reads them from the destination on demand. The
            Git size a sync records is read before it pulls, so it trails by one sync.
          </p>
        </div>
      </div>
    </TooltipProvider>
  );
}
