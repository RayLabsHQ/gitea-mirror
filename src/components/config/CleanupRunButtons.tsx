import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, LoaderCircle, Play, TriangleAlert } from "lucide-react";
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
import { OptionRow } from "./settings-ui";

const MAINTENANCE_API_PATH = withBase("/api/cleanup/maintenance");
const REPOSITORY_CLEANUP_API_PATH = withBase("/api/cleanup/trigger");

/** A run that answers at once would only flash its progress, so it stays up this long. */
const MIN_RUNNING_MS = 700;

/** What the ⓘ next to a result opens. */
export interface CleanupRunDetails {
  title: string;
  text?: string;
  items?: string[];
  itemsLabel?: string;
  errors?: string[];
}

/**
 * A Run now as the card shows it (#547). The result stays until the next run
 * or a reload, so its details stay one click away.
 */
export type CleanupRunState =
  | { kind: "idle" }
  | { kind: "running"; text: string }
  | { kind: "done"; tone: "success" | "warning"; text: string; details?: CleanupRunDetails }
  | { kind: "error"; text: string; details: CleanupRunDetails };

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
      setState({ kind: "running", text: `Removing activity older than ${retentionLabel}` });
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
          text:
            removed === 0
              ? `Nothing was older than ${retentionLabel}`
              : `Removed ${plural(result.mirrorJobsDeleted, "activity entry", "activity entries")} and ${plural(result.eventsDeleted, "event")}`,
        });
      } catch (error) {
        const message = errorText(error);
        setState({
          kind: "error",
          text: `Failed: ${message}`,
          details: { title: "Database maintenance failed", errors: [message] },
        });
      }
    },
    [onRecorded]
  );

  return { state, run };
}

/** The state and the run for Repository Cleanup's Run now. */
export function useRepositoryCleanupRun() {
  const [state, setState] = useState<CleanupRunState>({ kind: "idle" });

  const run = useCallback(async () => {
    setState({ kind: "running", text: "Checking your sources for repositories that are gone" });
    try {
      const { results } = await post<{
        results: {
          orphanedCount: number;
          processedCount: number;
          errorCount: number;
          errors: string[];
          repositories: string[];
          waiting?: { fullName: string; actOn: string }[];
          dryRun: boolean;
          action: "skip" | "archive" | "delete";
        };
      }>(REPOSITORY_CLEANUP_API_PATH);
      const found = plural(results.orphanedCount, "repository", "repositories");
      const itemsLabel = "Repositories whose source is gone";
      // Repositories inside the wait before acting (#549) show their date.
      const waiting = results.waiting ?? [];
      const actOnByName = new Map(waiting.map((entry) => [entry.fullName, entry.actOn] as const));
      const items = results.repositories.map((name) => {
        const actOn = actOnByName.get(name);
        return actOn
          ? `${name} (waiting until ${new Date(actOn).toLocaleDateString(undefined, { dateStyle: "medium" })})`
          : name;
      });
      if (results.orphanedCount === 0) {
        setState({ kind: "done", tone: "success", text: "Every repository's source is still there" });
      } else if (results.dryRun) {
        setState({
          kind: "done",
          tone: "success",
          text: `Dry run: the source is gone for ${found}${
            waiting.length > 0 ? `, ${waiting.length} still waiting` : ""
          }. Nothing was changed.`,
          details: {
            title: "Dry run",
            text: "Nothing was changed. Turn off Dry run to apply the action.",
            items,
            itemsLabel,
          },
        });
      } else {
        const done =
          results.action === "skip" ? "left as they are" : results.action === "archive" ? "archived" : "removed";
        const counts: string[] = [];
        if (results.processedCount > 0 || waiting.length === 0) counts.push(`${results.processedCount} ${done}`);
        if (waiting.length > 0) counts.push(`${waiting.length} waiting`);
        if (results.errorCount > 0) counts.push(`${results.errorCount} failed`);
        setState({
          kind: "done",
          tone: results.errorCount > 0 ? "warning" : "success",
          text: `The source is gone for ${found}: ${counts.join(", ")}`,
          details: {
            title: "Repository cleanup",
            items,
            itemsLabel,
            errors: results.errors,
          },
        });
      }
    } catch (error) {
      const message = errorText(error);
      setState({
        kind: "error",
        text: `Failed: ${message}`,
        details: { title: "Repository cleanup failed", errors: [message] },
      });
    }
  }, []);

  return { state, run };
}

/**
 * One line of text. When it does not fit, it scrolls to its end and back;
 * with reduced motion it is cut off with an ellipsis.
 */
function MarqueeText({ text, className }: { text: string; className?: string }) {
  const outer = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const element = outer.current;
    if (!element) return;
    const measure = () => {
      const extra = element.scrollWidth - element.clientWidth;
      setOverflow(extra > 1 ? extra : 0);
    };
    setOverflow(0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  const style = overflow
    ? ({
        "--marquee-shift": `-${overflow + 12}px`,
        "--marquee-duration": `${Math.max(4, overflow / 30 + 3)}s`,
      } as CSSProperties)
    : undefined;

  return (
    <span
      ref={outer}
      title={overflow ? text : undefined}
      className={cn("block min-w-0 truncate", overflow && "cleanup-marquee-mask", className)}
    >
      <span className={overflow ? "cleanup-marquee" : undefined} style={style}>
        {text}
      </span>
    </span>
  );
}

function RunDetailsDialog({
  details,
  open,
  onOpenChange,
}: {
  details: CleanupRunDetails;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{details.title}</DialogTitle>
          {details.text && <DialogDescription>{details.text}</DialogDescription>}
        </DialogHeader>
        {details.errors && details.errors.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {details.errors.length === 1 ? "Error" : `Errors (${details.errors.length})`}
            </p>
            <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              {details.errors.map((error, index) => (
                <li key={index} className="whitespace-pre-wrap break-words">
                  {error}
                </li>
              ))}
            </ul>
          </div>
        )}
        {details.items && details.items.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {details.itemsLabel ?? "Items"} ({details.items.length})
            </p>
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[13px]">
              {details.items.map((item) => (
                <li key={item} className="break-all">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The status of a run in one line: a spinner while it runs, then the outcome
 * with an ⓘ that opens the details when there are any. `idle` is what the
 * line says before the first run.
 */
function RunStatusLine({
  state,
  idle,
  className,
}: {
  state: CleanupRunState;
  idle: ReactNode;
  className?: string;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (state.kind === "idle") return <>{idle}</>;

  const details = state.kind === "running" ? undefined : state.details;
  const icon =
    state.kind === "running" ? (
      <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500" />
    ) : state.kind === "error" ? (
      <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
    ) : state.tone === "warning" ? (
      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
    ) : (
      <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
    );

  return (
    <div role="status" aria-live="polite" className={cn("flex min-w-0 items-center gap-2", className)}>
      {icon}
      <MarqueeText text={state.kind === "running" ? `${state.text}…` : state.text} />
      {details && (
        <>
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            aria-label="Show details"
            className="shrink-0 rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          <RunDetailsDialog details={details} open={detailsOpen} onOpenChange={setDetailsOpen} />
        </>
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
      className="h-8 shrink-0 gap-1.5 text-xs"
      onClick={onClick}
      disabled={running}
    >
      {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
      {running ? "Running" : "Run now"}
    </Button>
  );
}

/**
 * Database Maintenance's Run now row (#547), laid out like the switch rows on
 * the other cards. Its description turns into the run's status.
 */
export function DatabaseMaintenanceRunRow({
  state,
  retentionLabel,
  onRun,
}: {
  state: CleanupRunState;
  retentionLabel: string;
  onRun: () => void;
}) {
  return (
    <OptionRow
      label="Run maintenance now"
      subContent={
        <RunStatusLine
          state={state}
          className="text-[13px] text-muted-foreground"
          idle={
            <p className="text-[13px] text-muted-foreground">
              Removes activity older than {retentionLabel} right away
            </p>
          }
        />
      }
      right={<RunNowButton running={state.kind === "running"} onClick={onRun} />}
    />
  );
}

/** Repository Cleanup's footer line: the schedule, or the run's status (#547). */
export function RepositoryCleanupFooterStatus({ state }: { state: CleanupRunState }) {
  return (
    <RunStatusLine
      state={state}
      className="flex-1 text-xs text-muted-foreground"
      idle={
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground/70">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Checks every 6 hours and with each scheduled sync</span>
        </div>
      }
    />
  );
}

function describeAction(config: DatabaseCleanupConfig): string | null {
  const action = config.orphanedRepoAction ?? "archive";
  if (config.dryRun || action === "skip") return null;
  const days = Math.max(0, Math.floor(config.orphanedRepoGraceDays ?? 0));
  const subject =
    days > 0
      ? `Repositories whose source has been gone for ${days} ${days === 1 ? "day" : "days"} or more`
      : "Repositories whose source is gone";
  if (action === "archive") {
    return config.deleteFromGitea
      ? `${subject} will be archived here and on the destination.`
      : `${subject} will be marked archived here. The copies on the destination stay as they are.`;
  }
  return config.deleteFromGitea
    ? `${subject} will be removed here and deleted from the destination. This cannot be undone.`
    : `${subject} will be removed here. The copies on the destination stay as they are.`;
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
