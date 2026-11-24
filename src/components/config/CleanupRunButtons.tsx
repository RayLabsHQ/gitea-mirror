import { useCallback, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, Play, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { withBase } from "@/lib/base-path";
import { cn } from "@/lib/utils";
import type { DatabaseCleanupConfig } from "@/types/config";

const MAINTENANCE_API_PATH = withBase("/api/cleanup/maintenance");
const REPOSITORY_CLEANUP_API_PATH = withBase("/api/cleanup/trigger");

/** A run that answers at once would only flash its progress, so it stays up this long. */
const MIN_RUNNING_MS = 700;

/** What a Run now shows under its card's settings (#547). */
export type CleanupRunState =
  | { kind: "idle" }
  | { kind: "running"; title: string; detail?: string }
  | {
      kind: "done";
      tone: "success" | "warning";
      title: string;
      detail?: string;
      items?: string[];
    }
  | { kind: "error"; title: string; detail?: string };

async function post<T>(path: string): Promise<T> {
  const started = Date.now();
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      throw new Error(body?.error || body?.message || `Request failed (${response.status})`);
    }
    return body as T;
  } finally {
    const left = MIN_RUNNING_MS - (Date.now() - started);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The state and the run for Database Maintenance's Run now. */
export function useDatabaseMaintenanceRun(
  onRecorded?: (times: { lastRun: Date; nextRun: Date }) => void
) {
  const [state, setState] = useState<CleanupRunState>({ kind: "idle" });

  const run = useCallback(
    async (retentionLabel: string) => {
      setState({
        kind: "running",
        title: `Removing activity older than ${retentionLabel}`,
      });
      try {
        const result = await post<{
          eventsDeleted: number;
          mirrorJobsDeleted: number;
          lastRun: string;
          nextRun: string;
        }>(MAINTENANCE_API_PATH);
        onRecorded?.({ lastRun: new Date(result.lastRun), nextRun: new Date(result.nextRun) });
        const removed = result.eventsDeleted + result.mirrorJobsDeleted;
        setState({
          kind: "done",
          tone: "success",
          title:
            removed === 0
              ? `Nothing was older than ${retentionLabel}`
              : `Removed ${plural(result.mirrorJobsDeleted, "activity entry", "activity entries")} and ${plural(result.eventsDeleted, "event")}`,
          detail: "The next run is counted from now.",
        });
      } catch (error) {
        setState({ kind: "error", title: "Database maintenance failed", detail: errorText(error) });
      }
    },
    [onRecorded]
  );

  return { state, run, dismiss: () => setState({ kind: "idle" }) };
}

/** The state and the run for Repository Cleanup's Run now. */
export function useRepositoryCleanupRun() {
  const [state, setState] = useState<CleanupRunState>({ kind: "idle" });

  const run = useCallback(async () => {
    setState({
      kind: "running",
      title: "Checking your sources for repositories that are gone",
      detail: "With many repositories this can take a few minutes.",
    });
    try {
      const { results } = await post<{
        results: {
          orphanedCount: number;
          processedCount: number;
          errorCount: number;
          errors: string[];
          repositories: string[];
          dryRun: boolean;
          action: "skip" | "archive" | "delete";
        };
      }>(REPOSITORY_CLEANUP_API_PATH);
      const found = plural(results.orphanedCount, "repository", "repositories");
      if (results.orphanedCount === 0) {
        setState({ kind: "done", tone: "success", title: "Every repository's source is still there" });
      } else if (results.dryRun) {
        setState({
          kind: "done",
          tone: "success",
          title: `Dry run: the source is gone for ${found}`,
          detail: "Nothing was changed. Turn off Dry run to apply the action.",
          items: results.repositories,
        });
      } else {
        const done =
          results.action === "skip" ? "left as they are" : results.action === "archive" ? "archived" : "removed";
        setState({
          kind: "done",
          tone: results.errorCount > 0 ? "warning" : "success",
          title: `The source is gone for ${found}: ${results.processedCount} ${done}`,
          detail:
            results.errorCount > 0
              ? `${plural(results.errorCount, "failed")}: ${results.errors[0]}`
              : undefined,
          items: results.repositories,
        });
      }
    } catch (error) {
      setState({ kind: "error", title: "Repository cleanup failed", detail: errorText(error) });
    }
  }, []);

  return { state, run, dismiss: () => setState({ kind: "idle" }) };
}

const SHOWN_ITEMS = 5;

/**
 * Progress and outcome of a Run now, shown under the card's settings. Hidden
 * until the first run on this page.
 */
export function CleanupRunStatus({
  state,
  onDismiss,
  className,
}: {
  state: CleanupRunState;
  onDismiss?: () => void;
  className?: string;
}) {
  if (state.kind === "idle") return null;

  if (state.kind === "running") {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn("space-y-2.5 rounded-lg border border-border bg-muted/40 px-4 py-3", className)}
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-indigo-500" />
          <span>{state.title}</span>
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-indigo-500/15">
          <div className="cleanup-progress-bar absolute inset-y-0 w-1/3 rounded-full bg-indigo-500" />
        </div>
        {state.detail && <p className="text-xs text-muted-foreground">{state.detail}</p>}
      </div>
    );
  }

  const tone = state.kind === "error" ? "error" : state.tone;
  const Icon = tone === "success" ? CircleCheck : tone === "warning" ? TriangleAlert : CircleAlert;
  const items = state.kind === "done" ? state.items ?? [] : [];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-4 py-3",
        tone === "success" && "border-emerald-500/30 bg-emerald-500/5",
        tone === "warning" && "border-amber-500/40 bg-amber-500/5",
        tone === "error" && "border-destructive/40 bg-destructive/5",
        className
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          tone === "success" && "text-emerald-600 dark:text-emerald-400",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
          tone === "error" && "text-destructive"
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{state.title}</p>
        {items.length > 0 && (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {items.slice(0, SHOWN_ITEMS).map((name) => (
              <li key={name} className="truncate font-mono">
                {name}
              </li>
            ))}
            {items.length > SHOWN_ITEMS && <li>and {items.length - SHOWN_ITEMS} more</li>}
          </ul>
        )}
        {state.detail && <p className="text-xs text-muted-foreground">{state.detail}</p>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function RunNowButton({ running, onClick }: { running: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 text-xs"
      onClick={onClick}
      disabled={running}
    >
      {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
      {running ? "Running" : "Run now"}
    </Button>
  );
}

/** Database Maintenance's Run now (#547). */
export function RunDatabaseMaintenanceButton({
  state,
  onRun,
}: {
  state: CleanupRunState;
  onRun: () => void;
}) {
  return <RunNowButton running={state.kind === "running"} onClick={onRun} />;
}

function describeAction(config: DatabaseCleanupConfig): string | null {
  const action = config.orphanedRepoAction ?? "archive";
  if (config.dryRun || action === "skip") return null;
  if (action === "archive") {
    return config.deleteFromGitea
      ? "Repositories whose source is gone will be archived here and on the destination."
      : "Repositories whose source is gone will be marked archived here. The copies on the destination stay as they are.";
  }
  return config.deleteFromGitea
    ? "Repositories whose source is gone will be removed here and deleted from the destination. This cannot be undone."
    : "Repositories whose source is gone will be removed here. The copies on the destination stay as they are.";
}

/**
 * Repository Cleanup's Run now (#547). A run that changes anything asks
 * first; a dry run or the skip action does not.
 */
export function RunRepositoryCleanupButton({
  config,
  state,
  onRun,
}: {
  config: DatabaseCleanupConfig;
  state: CleanupRunState;
  onRun: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const warning = describeAction(config);

  return (
    <>
      <RunNowButton
        running={state.kind === "running"}
        onClick={() => (warning ? setConfirming(true) : onRun())}
      />
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Run repository cleanup now?</DialogTitle>
            <DialogDescription>
              This checks your sources now instead of at the next scheduled check. {warning}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={config.orphanedRepoAction === "delete" ? "destructive" : "default"}
              onClick={() => {
                setConfirming(false);
                onRun();
              }}
            >
              Run cleanup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
