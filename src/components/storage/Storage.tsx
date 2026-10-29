import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Database,
  HardDrive,
  Info,
  Package,
  ScanSearch,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { StatusCard } from "@/components/dashboard/StatusCard";
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
import { apiRequest, cn, formatLastSyncTime } from "@/lib/utils";
import { buildGiteaWebUrl } from "@/lib/gitea-url";
import { formatBytes } from "@/lib/utils/format-bytes";
import type { StorageOverview, StorageRepository } from "@/lib/repository-storage";

type StorageApiResponse = ({ success: true } & StorageOverview) | { success: false; error?: string };

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

  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "total", descending: true });

  const fetchOverview = useCallback(
    async (isLiveRefresh = false) => {
      if (!user?.id) return;
      try {
        const response = await apiRequest<StorageApiResponse>("/storage", { method: "GET" });
        if (response.success) {
          setOverview(response);
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
    setIsLoading(true);
    fetchOverview(false);
  }, [fetchOverview, navigationKey]);

  useEffect(() => registerRefreshCallback(() => fetchOverview(true)), [registerRefreshCallback, fetchOverview]);

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
            already fetches. Sizes show up here after the next sync.
          </p>
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

              {visibleRepositories.map((repo) => {
                const destinationUrl = repo.location ? buildGiteaWebUrl(giteaConfig, repo.location) : null;
                const heavy = isReleaseHeavy(repo);
                return (
                  <div
                    key={repo.id}
                    data-testid="storage-row"
                    className="group min-h-[48px] flex items-center border-b last:border-b-0 hover:bg-muted/50 text-sm"
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
          <p className="text-xs text-muted-foreground">
            Sizes are what the destination reports: Git and LFS together, plus the release assets it stores. Each sync
            records them from data it already fetches. The Git size is read before the sync pulls, so it trails by one
            sync.
          </p>
        </div>
      </div>
    </TooltipProvider>
  );
}
