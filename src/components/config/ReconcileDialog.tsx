import { useCallback, useEffect, useState } from "react";
import { GitCompare, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { withBase } from "@/lib/base-path";

interface ReconcileReport {
  untracked: Array<{ location: string; originalUrl: string; sourcePath: string; isPrivate: boolean }>;
  missing: Array<{ id: string; fullName: string; location: string }>;
  /** Rows whose recorded mirror is gone while the same source is mirrored under another owner. */
  moved: Array<{ id: string; fullName: string; from: string; to: string }>;
  notManaged: Array<{ location: string; reason: string }>;
  unverified: Array<{ fullName: string; location: string; error: string }>;
  healthyCount: number;
  /** Rows mirrored to another destination host, left out of the comparison. */
  elsewhereCount?: number;
  scannedOwners: string[];
  skippedOwners: string[];
  totalOnDestination: number;
}

type AppliedSummary = { adopted: number; reset: number; relocated: number; skipped: number };

interface ReconcileResponse {
  success: boolean;
  dryRun: boolean;
  report: ReconcileReport;
  applied: AppliedSummary | null;
  error?: string;
}

const RECONCILE_API_PATH = withBase("/api/cleanup/reconcile");
const MAX_LISTED = 8;

async function postReconcile(body: {
  dryRun: boolean;
  adoptUntracked?: boolean;
  resetMissing?: boolean;
  relocateMoved?: boolean;
}): Promise<ReconcileResponse> {
  const response = await fetch(RECONCILE_API_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Partial<ReconcileResponse>;
  if (!response.ok || !data.success || !data.report) {
    throw new Error(data.error || `Reconcile failed (${response.status})`);
  }
  return data as ReconcileResponse;
}

function RepoList({
  title,
  items,
  hint,
  tone = "muted",
}: {
  title: string;
  items: string[];
  hint: string;
  tone?: "muted" | "amber" | "rose";
}) {
  const shown = items.slice(0, MAX_LISTED);
  const rest = items.length - shown.length;
  const countClass =
    tone === "amber"
      ? "text-amber-500"
      : tone === "rose"
        ? "text-rose-500"
        : "text-muted-foreground";
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{title}</span>
        <span className={`text-xs font-semibold tabular-nums ${countClass}`}>{items.length}</span>
      </div>
      <p className="text-[12px] text-muted-foreground">{hint}</p>
      {shown.length > 0 && (
        <ul className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[12px]">
          {shown.map((item) => (
            <li key={item} className="truncate" title={item}>
              {item}
            </li>
          ))}
          {rest > 0 && (
            <li className="pt-1 font-sans text-muted-foreground">and {rest} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

interface ReconcileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Compares the destination with the repository database. Runs a dry run on
 * open, then applies the opt-in fixes the user ticks.
 */
export function ReconcileDialog({ open, onOpenChange }: ReconcileDialogProps) {
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [applied, setApplied] = useState<AppliedSummary | null>(null);
  const [adopt, setAdopt] = useState(false);
  const [reset, setReset] = useState(false);
  const [relocate, setRelocate] = useState(false);

  const runDryRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await postReconcile({ dryRun: true });
      setReport(result.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconcile failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setReport(null);
    setApplied(null);
    setAdopt(false);
    setReset(false);
    setRelocate(false);
    void runDryRun();
  }, [open, runDryRun]);

  const apply = async () => {
    if (!adopt && !reset && !relocate) return;
    setApplying(true);
    setError(null);
    try {
      const result = await postReconcile({
        dryRun: false,
        adoptUntracked: adopt,
        resetMissing: reset,
        relocateMoved: relocate,
      });
      const summary = result.applied ?? { adopted: 0, reset: 0, relocated: 0, skipped: 0 };
      setApplied(summary);
      toast.success(
        `Adopted ${summary.adopted} untracked mirror${summary.adopted === 1 ? "" : "s"}, recorded ${summary.relocated} new location${summary.relocated === 1 ? "" : "s"}, reset ${summary.reset} missing row${summary.reset === 1 ? "" : "s"}`
      );
      setAdopt(false);
      setReset(false);
      setRelocate(false);
      await runDryRun();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Reconcile failed";
      setError(message);
      toast.error(message);
    } finally {
      setApplying(false);
    }
  };

  const untrackedCount = report?.untracked.length ?? 0;
  const missingCount = report?.missing.length ?? 0;
  const movedCount = report?.moved.length ?? 0;
  const busy = loading || applying;
  const nothingTicked = !adopt && !reset && !relocate;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Reconcile with destination</DialogTitle>
          <DialogDescription>
            Compares what the destination holds with the repositories this app tracks. Only mirrors of the configured source are considered. Nothing is deleted or archived here.
          </DialogDescription>
        </DialogHeader>

        {loading && !report && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Listing the destination…
          </div>
        )}

        {error && (
          <p className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-500">
            {error}
          </p>
        )}

        {report && (
          // min-w-0: DialogContent is a grid, and a long monospace entry would
          // otherwise widen the track past the panel instead of truncating.
          <div className="min-w-0 space-y-4">
            <p className="text-[12px] text-muted-foreground">
              {report.totalOnDestination} repositor{report.totalOnDestination === 1 ? "y" : "ies"} under{" "}
              {report.scannedOwners.length} owner{report.scannedOwners.length === 1 ? "" : "s"} on the destination,{" "}
              {report.healthyCount} tracked and present.
              {(report.elsewhereCount ?? 0) > 0 && (
                <>
                  {" "}
                  {report.elsewhereCount} row{report.elsewhereCount === 1 ? " is" : "s are"} mirrored to a previous
                  destination and {report.elsewhereCount === 1 ? "was" : "were"} left out.
                </>
              )}
              {report.skippedOwners.length > 0 && (
                <> Not found there: {report.skippedOwners.join(", ")}.</>
              )}
            </p>

            <RepoList
              title="On the destination, not in the database"
              items={report.untracked.map((r) => r.location)}
              hint="Mirrors of your source that this app does not know about. Adopting them adds a row so scheduled sync and cleanup include them."
              tone={untrackedCount > 0 ? "amber" : "muted"}
            />
            <RepoList
              title="Moved on the destination"
              items={report.moved.map((r) => `${r.to} (was ${r.from})`)}
              hint="Rows whose recorded mirror is gone while a mirror of the same source sits under another owner, usually after a transfer in Gitea. Recording the new location makes sync follow it."
              tone={movedCount > 0 ? "amber" : "muted"}
            />
            <RepoList
              title="In the database, gone from the destination"
              items={report.missing.map((r) => `${r.fullName} (was ${r.location})`)}
              hint="Rows marked mirrored whose repository is no longer there. Resetting them makes the next mirror run recreate the mirror."
              tone={missingCount > 0 ? "rose" : "muted"}
            />
            {report.notManaged.length > 0 && (
              <RepoList
                title="Not managed by gitea-mirror"
                items={report.notManaged.map((r) => `${r.location} (${r.reason})`)}
                hint="Native repositories, mirrors of other hosts, and second copies of a tracked mirror. These are listed for information and never touched."
              />
            )}
            {report.unverified.length > 0 && (
              <RepoList
                title="Could not be verified"
                items={report.unverified.map((r) => `${r.fullName}: ${r.error}`)}
                hint="The destination did not answer the presence check for these rows. They were left alone."
                tone="amber"
              />
            )}

            {applied && (
              <p className="text-[12px] text-muted-foreground">
                Applied: adopted {applied.adopted}, recorded {applied.relocated}, reset {applied.reset}
                {applied.skipped > 0 ? `, skipped ${applied.skipped}` : ""}. The lists above are refreshed.
              </p>
            )}

            <div className="space-y-2 rounded-lg border border-border p-3">
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox
                  checked={adopt}
                  onCheckedChange={(checked) => setAdopt(checked === true)}
                  disabled={busy || untrackedCount === 0}
                  className="mt-0.5"
                />
                <span>
                  Adopt the {untrackedCount} untracked mirror{untrackedCount === 1 ? "" : "s"}
                  <span className="block text-[12px] text-muted-foreground">
                    Creates database rows from the source URL of each mirror.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox
                  checked={relocate}
                  onCheckedChange={(checked) => setRelocate(checked === true)}
                  disabled={busy || movedCount === 0}
                  className="mt-0.5"
                />
                <span>
                  Record the {movedCount} new location{movedCount === 1 ? "" : "s"}
                  <span className="block text-[12px] text-muted-foreground">
                    Points each row at where its mirror is now. Nothing is moved, created or deleted on the destination.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox
                  checked={reset}
                  onCheckedChange={(checked) => setReset(checked === true)}
                  disabled={busy || missingCount === 0}
                  className="mt-0.5"
                />
                <span>
                  Reset the {missingCount} missing row{missingCount === 1 ? "" : "s"}
                  <span className="block text-[12px] text-muted-foreground">
                    Marks them as imported so the next mirror run recreates them. Rows are never deleted.
                  </span>
                </span>
              </label>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          <Button type="button" variant="outline" onClick={() => void runDryRun()} disabled={busy}>
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            Check again
          </Button>
          <Button type="button" onClick={() => void apply()} disabled={busy || nothingTicked}>
            {applying ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The button that opens the dialog, for the Repository Cleanup card. */
export function ReconcileDestinationButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
      >
        <GitCompare className="h-3.5 w-3.5" />
        Reconcile with destination
      </Button>
      <ReconcileDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
