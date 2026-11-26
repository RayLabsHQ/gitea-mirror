import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Ban,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  Info,
  LoaderCircle,
  Minus,
  MoveRight,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
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
import type {
  BlockedMove,
  PlacementPreview,
  PlacementSkip,
  PlacementSummary,
  PlacementVia,
  PlannedMove,
} from "@/lib/mirror-placement";
import type { PlacementItemStatus, PlacementRunItem, PlacementRunState } from "@/lib/mirror-placement-run";

const SUMMARY_PATH = withBase("/api/placement/summary");
const PREVIEW_PATH = withBase("/api/placement/preview");
const RUN_PATH = withBase("/api/placement/run");
const RENAME_KEY = "gitea-mirror:placement-rename";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    throw new Error(body?.error || body?.message || `Request failed (${response.status})`);
  }
  return body as T;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const VIA_LABEL: Record<PlacementVia, string> = {
  strategy: "",
  organization: "set on the organization",
  repository: "set on the repository",
  starred: "starred",
};

function readRename(): boolean {
  try {
    return localStorage.getItem(RENAME_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveRename(value: boolean) {
  try {
    localStorage.setItem(RENAME_KEY, String(value));
  } catch {
    // Only a convenience.
  }
}

/**
 * The footer of the Organization Structure card (#550): how many existing
 * mirrors are not where the settings put them, with the way to move them.
 * Asks again after every saved change.
 */
export function MirrorPlacementFooter({ refreshKey, isSaving }: { refreshKey: string; isSaving?: boolean }) {
  const [summary, setSummary] = useState<PlacementSummary | null>(null);
  const [run, setRun] = useState<PlacementRunState | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSummary(await call<PlacementSummary>(SUMMARY_PATH));
    } catch {
      setSummary(null);
    }
  }, []);

  // After the settings are saved, not while they are.
  useEffect(() => {
    if (isSaving) return;
    const timer = setTimeout(refresh, 500);
    return () => clearTimeout(timer);
  }, [refreshKey, isSaving, refresh]);

  // A run started before a reload is picked up again.
  useEffect(() => {
    call<{ run: PlacementRunState | null }>(RUN_PATH)
      .then(({ run }) => run && run.state !== "done" && setRun(run))
      .catch(() => undefined);
  }, []);

  const isRunning = run !== null && run.state !== "done";
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(async () => {
      try {
        const { run: next } = await call<{ run: PlacementRunState | null }>(RUN_PATH);
        setRun(next);
        if (!next || next.state === "done") refresh();
      } catch {
        // Try again on the next tick.
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [isRunning, refresh]);

  const running = isRunning;
  if (!running && (!summary?.supported || summary.outOfPlace + summary.inPlace === 0)) {
    return <FooterText icon={Info}>Strategy applies to newly mirrored repositories</FooterText>;
  }

  const count = summary?.outOfPlace ?? 0;
  const settled = run ? run.items.filter((item) => item.status !== "waiting" && item.status !== "moving").length : 0;

  return (
    <>
      {running ? (
        <FooterText icon={LoaderCircle} spin>
          Moving mirrors: {settled} of {run!.items.length} done
        </FooterText>
      ) : count > 0 ? (
        <FooterText icon={TriangleAlert} tone="warning">
          {count === 1 ? "1 mirror doesn't" : `${count} mirrors don't`} match these settings
        </FooterText>
      ) : (
        <FooterText icon={CircleCheck}>Every mirror is where these settings put it</FooterText>
      )}
      {(running || count > 0) && (
        <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1.5 text-xs" onClick={() => setOpen(true)}>
          {running ? "View" : <><MoveRight className="h-3.5 w-3.5" />Review and move</>}
        </Button>
      )}
      <MirrorPlacementDialog
        open={open}
        onOpenChange={setOpen}
        run={run}
        onRun={setRun}
        onChanged={refresh}
      />
    </>
  );
}

function FooterText({
  icon: Icon,
  tone,
  spin,
  children,
}: {
  icon: typeof Info;
  tone?: "warning";
  spin?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 text-xs",
        tone === "warning" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground/80"
      )}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", spin && "animate-spin text-indigo-500")} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "preview"; preview: PlacementPreview };

function MirrorPlacementDialog({
  open,
  onOpenChange,
  run,
  onRun,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: PlacementRunState | null;
  onRun: (run: PlacementRunState | null) => void;
  onChanged: () => void;
}) {
  const [rename, setRename] = useState(readRename);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [starting, setStarting] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [blockedAtStart, setBlockedAtStart] = useState(0);
  const request = useRef(0);

  const load = useCallback(async (withRename: boolean) => {
    const id = ++request.current;
    setView({ kind: "loading" });
    try {
      const preview = await call<PlacementPreview>(PREVIEW_PATH, {
        method: "POST",
        body: JSON.stringify({ rename: withRename }),
      });
      if (id === request.current) setView({ kind: "preview", preview });
    } catch (error) {
      if (id === request.current) setView({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const running = run !== null && run.state !== "done";
  useEffect(() => {
    if (!open) return;
    if (running) {
      setShowRun(true);
      return;
    }
    if (!showRun) load(rename);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleRename = (value: boolean) => {
    setRename(value);
    saveRename(value);
    load(value);
  };

  const start = async (preview: PlacementPreview) => {
    setStarting(true);
    try {
      const { run } = await call<{ run: PlacementRunState }>(RUN_PATH, {
        method: "POST",
        body: JSON.stringify({ rename: preview.rename, moves: preview.moves.map((move) => ({ id: move.id, to: move.to })) }),
      });
      onRun(run);
      setBlockedAtStart(preview.blocked.length);
      setShowRun(true);
    } catch (error) {
      setView({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setStarting(false);
    }
  };

  const checkAgain = () => {
    setShowRun(false);
    onRun(null);
    onChanged();
    load(rename);
  };

  const close = (next: boolean) => {
    if (!next && run?.state === "done") {
      setShowRun(false);
      onRun(null);
      onChanged();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[min(88vh,52rem)] flex-col gap-0 p-0 sm:max-w-2xl">
        {showRun && run ? (
          <RunView run={run} blocked={blockedAtStart} onCheckAgain={checkAgain} onClose={() => close(false)} />
        ) : (
          <>
            <DialogHeader className="space-y-1.5 px-6 pb-4 pt-6">
              <DialogTitle className="pr-6">Move mirrors to match your settings</DialogTitle>
              <DialogDescription>
                These mirrors were created before your settings changed, so they sit somewhere else on the
                destination. Moving transfers each one to its new place. Nothing is deleted or downloaded again.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-start justify-between gap-4 border-y border-border bg-muted/30 px-6 pb-3.5 pt-2.5">
              <div className="space-y-0.5">
                <label htmlFor="placement-rename" className="text-sm font-medium">
                  Use the source name
                </label>
                <p className="text-xs text-muted-foreground">
                  A moved mirror takes its source repository's name, like a new mirror. Off keeps its current name.
                </p>
              </div>
              <Switch
                id="placement-rename"
                checked={rename}
                onCheckedChange={toggleRename}
                disabled={view.kind === "loading"}
                className="mt-0.5 data-[state=checked]:bg-indigo-600"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {view.kind === "loading" && <LoadingView />}
              {view.kind === "error" && <ErrorView message={view.message} onRetry={() => load(rename)} />}
              {view.kind === "preview" && <PreviewView preview={view.preview} />}
            </div>

            <DialogFooter className="items-center gap-2 border-t border-border px-6 py-4 sm:justify-between">
              <p className="text-xs text-muted-foreground">
                {view.kind === "preview" && view.preview.blocked.length > 0
                  ? `${plural(view.preview.blocked.length, "blocked mirror")} ${view.preview.blocked.length === 1 ? "stays where it is" : "stay where they are"} and keep${view.preview.blocked.length === 1 ? "s" : ""} syncing.`
                  : ""}
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => close(false)}>
                  Cancel
                </Button>
                {view.kind === "preview" && view.preview.moves.length > 0 && (
                  <Button type="button" onClick={() => start(view.preview)} disabled={starting} className="gap-1.5">
                    {starting && <LoaderCircle className="h-4 w-4 animate-spin" />}
                    Move {plural(view.preview.moves.length, "mirror")}
                  </Button>
                )}
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LoadingView() {
  return (
    <div className="space-y-3" aria-busy="true">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="h-4 w-4 animate-spin text-indigo-500" />
        Checking each mirror on the destination
      </p>
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="h-9 animate-pulse rounded-md bg-muted/60" style={{ opacity: 1 - index * 0.2 }} />
      ))}
    </div>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
      <p className="flex items-start gap-2 text-sm">
        <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        {message}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
        <RefreshCw className="h-3.5 w-3.5" />
        Try again
      </Button>
    </div>
  );
}

function PreviewView({ preview }: { preview: PlacementPreview }) {
  const groups = useMemo(() => {
    const byOwner = new Map<string, PlannedMove[]>();
    for (const move of preview.moves) {
      const owner = move.to.split("/")[0];
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), move]);
    }
    return [...byOwner.entries()];
  }, [preview.moves]);

  if (preview.moves.length === 0 && preview.blocked.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <CircleCheck className="h-8 w-8 text-emerald-500" />
        <p className="text-sm font-medium">Every mirror is where your settings put it</p>
        {preview.skipped.length > 0 && (
          <p className="text-xs text-muted-foreground">{plural(preview.skipped.length, "mirror")} left out, listed below.</p>
        )}
        {preview.skipped.length > 0 && <div className="w-full pt-4 text-left"><SkippedSection skipped={preview.skipped} /></div>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 text-xs">
        <Stat tone="indigo">{plural(preview.moves.length, "mirror")} to move</Stat>
        {preview.blocked.length > 0 && <Stat tone="amber">{preview.blocked.length} blocked</Stat>}
        {preview.skipped.length > 0 && <Stat>{preview.skipped.length} left out</Stat>}
        {preview.inPlace > 0 && <Stat>{preview.inPlace} already in place</Stat>}
      </div>


      {groups.length > 0 && (
        <Section title="Will move" count={preview.moves.length} defaultOpen>
          <div className="space-y-4">
            {groups.map(([owner, moves]) => (
              <div key={owner}>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="font-mono text-[13px] font-semibold">{owner}</span>
                  <OwnerBadge state={moves[0].kind === "record" ? undefined : moves[0].ownerState} />
                  <span className="text-xs text-muted-foreground">{plural(moves.length, "mirror")}</span>
                </div>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {moves.map((move) => (
                    <MoveRow key={move.id} move={move} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {preview.blocked.length > 0 && (
        <Section title="Blocked" count={preview.blocked.length} tone="amber" defaultOpen>
          <ul className="divide-y divide-amber-500/15">
            {preview.blocked.map((entry) => (
              <BlockedRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </Section>
      )}

      {preview.skipped.length > 0 && <SkippedSection skipped={preview.skipped} />}

      <ul className="space-y-1.5 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
        <Note>Old links and clones keep working: the destination sends the old address on to the new one until another repository takes it.</Note>
        <Note>Access given through the old organization's teams does not come along. Collaborators on a repository do.</Note>
        <Note>Organizations left empty stay on the destination.</Note>
      </ul>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <Info className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

function Stat({ tone, children }: { tone?: "indigo" | "amber" | "red"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2.5 py-1 font-medium",
        tone === "indigo" && "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
        tone === "amber" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "red" && "border-destructive/30 bg-destructive/10 text-destructive",
        !tone && "border-border bg-muted/50 text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

function OwnerBadge({ state }: { state?: PlannedMove["ownerState"] }) {
  if (state === "new-organization") {
    return (
      <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-px text-[11px] font-medium text-indigo-700 dark:text-indigo-300">
        new organization
      </span>
    );
  }
  if (state === "account") {
    return <span className="rounded border border-border px-1.5 py-px text-[11px] text-muted-foreground">your account</span>;
  }
  return null;
}

function Section({
  title,
  count,
  tone,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  tone?: "amber";
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section
      className={cn(
        "rounded-lg",
        tone === "amber" && "border border-amber-500/30 bg-amber-500/5 px-3 pb-1"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-1.5 py-2 text-xs font-medium uppercase tracking-wider",
          tone === "amber" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
        )}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        {title} ({count})
      </button>
      {open && <div className="pb-2">{children}</div>}
    </section>
  );
}

function Path({ value, strong }: { value: string; strong?: boolean }) {
  return <span className={cn("break-all font-mono text-[13px]", strong ? "text-foreground" : "text-muted-foreground")}>{value}</span>;
}

function MoveRow({ move }: { move: PlannedMove }) {
  const details: string[] = [];
  if (move.kind === "record" && move.note) details.push(move.note);
  else {
    if (move.keptNameBecause) details.push(`Keeps its name: ${move.keptNameBecause}`);
    if (move.note) details.push(move.note);
  }
  const via = VIA_LABEL[move.via];
  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Path value={move.from} />
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <Path value={move.to} strong />
        {move.renamed && <Tag>renamed</Tag>}
        {move.kind === "record" && <Tag>nothing to move</Tag>}
        {via && <Tag subtle>{via}</Tag>}
      </div>
      {details.map((detail) => (
        <p key={detail} className="mt-0.5 text-xs text-muted-foreground">
          {detail}
        </p>
      ))}
    </li>
  );
}

function Tag({ subtle, children }: { subtle?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-px text-[11px]",
        subtle ? "text-muted-foreground/80" : "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

function BlockedRow({ entry }: { entry: BlockedMove }) {
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Path value={entry.from} strong />
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <Path value={entry.to} />
      </div>
      <p className="mt-1 flex gap-1.5 text-sm">
        <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>{entry.reason}</span>
      </p>
      {entry.hint && <p className="ml-5 text-xs text-muted-foreground">{entry.hint}</p>}
    </li>
  );
}

function SkippedSection({ skipped }: { skipped: PlacementSkip[] }) {
  return (
    <Section title="Left out" count={skipped.length}>
      <ul className="space-y-1 rounded-md border border-border p-3">
        {skipped.map((entry) => (
          <li key={entry.id} className="flex flex-wrap gap-x-2 text-xs">
            <Path value={entry.from} strong />
            <span className="text-muted-foreground">{entry.reason}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const STATUS_ORDER: PlacementItemStatus[] = ["failed", "pending", "skipped", "moving", "waiting", "moved", "recorded"];

function StatusIcon({ status }: { status: PlacementItemStatus }) {
  switch (status) {
    case "moving":
      return <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-indigo-500" />;
    case "moved":
    case "recorded":
      return <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" />;
    case "pending":
      return <Clock className="h-4 w-4 shrink-0 text-amber-500" />;
    case "failed":
      return <CircleX className="h-4 w-4 shrink-0 text-destructive" />;
    case "skipped":
      return <Minus className="h-4 w-4 shrink-0 text-muted-foreground" />;
    default:
      return <span className="block h-4 w-4 shrink-0 rounded-full border-2 border-border" />;
  }
}

function RunView({
  run,
  blocked,
  onCheckAgain,
  onClose,
}: {
  run: PlacementRunState;
  /** Mirrors the preview showed as blocked, which the run leaves alone. */
  blocked: number;
  onCheckAgain: () => void;
  onClose: () => void;
}) {
  const total = run.items.length;
  const count = (status: PlacementItemStatus) => run.items.filter((item) => item.status === status).length;
  const settled = run.items.filter((item) => item.status !== "waiting" && item.status !== "moving").length;
  const done = run.state === "done";
  const moved = count("moved") + count("recorded");
  const items = [...run.items].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.fullName.localeCompare(b.fullName)
  );

  const title = !done
    ? run.state === "checking"
      ? "Checking again before moving"
      : `Moving mirrors: ${settled} of ${total} done`
    : moved === total
      ? `Moved ${plural(moved, "mirror")}`
      : `Moved ${moved} of ${total}`;

  return (
    <>
      <DialogHeader className="space-y-3 px-6 pb-4 pt-6">
        <DialogTitle>{title}</DialogTitle>
        {!done ? (
          <>
            <Progress
              value={run.state === "checking" ? 4 : Math.round((settled / Math.max(total, 1)) * 100)}
              className="h-1.5"
              indicatorClassName="bg-indigo-500 duration-500"
            />
            <DialogDescription>You can close this; the move keeps going and the card shows its progress.</DialogDescription>
          </>
        ) : (
          <div className="flex flex-wrap gap-2 text-xs">
            {moved > 0 && <Stat tone="indigo">{moved} moved</Stat>}
            {count("pending") > 0 && <Stat tone="amber">{count("pending")} waiting for acceptance</Stat>}
            {count("failed") > 0 && <Stat tone="red">{count("failed")} failed</Stat>}
            {count("skipped") > 0 && <Stat>{count("skipped")} not moved</Stat>}
          </div>
        )}
        {done && blocked > 0 && (
          <p className="text-sm text-muted-foreground">
            {blocked === 1 ? "1 blocked mirror stayed where it is" : `${blocked} blocked mirrors stayed where they are`}{" "}
            and {blocked === 1 ? "keeps" : "keep"} syncing. Check again to see what holds {blocked === 1 ? "it" : "them"} back.
          </p>
        )}
        {run.stoppedBecause && (
          <p className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-sm">
            <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            {run.stoppedBecause}
          </p>
        )}
      </DialogHeader>
      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto border-y border-border">
        {items.map((item) => (
          <RunRow key={item.id} item={item} />
        ))}
      </ul>
      <DialogFooter className="gap-2 px-6 py-4">
        {done && (
          <Button type="button" variant="outline" onClick={onCheckAgain} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Check again
          </Button>
        )}
        <Button type="button" onClick={onClose} variant={done ? "default" : "outline"}>
          {done ? "Done" : "Close"}
        </Button>
      </DialogFooter>
    </>
  );
}

function RunRow({ item }: { item: PlacementRunItem }) {
  return (
    <li className="flex gap-3 px-6 py-2.5">
      <div className="pt-0.5">
        <StatusIcon status={item.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {item.from && <Path value={item.from} />}
          {item.from && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
          <Path value={item.to} strong />
        </div>
        {item.message && item.status !== "moved" && item.status !== "recorded" && (
          <p className={cn("mt-0.5 text-xs", item.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
            {item.message}
          </p>
        )}
        {item.message && item.status === "moved" && item.message.includes("not renamed") && (
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">{item.message}</p>
        )}
      </div>
    </li>
  );
}
