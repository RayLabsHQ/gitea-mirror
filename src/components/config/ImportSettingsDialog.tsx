import { useRef, useState } from "react";
import { CircleCheck, FileJson, LoaderCircle, TriangleAlert, Upload } from "lucide-react";
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
import type { SettingsImportSummary } from "@/lib/settings-import";

const IMPORT_API_PATH = withBase("/api/config/import");
const MAX_LISTED = 6;

const SECTION_LABELS: Record<string, string> = {
  githubConfig: "Sources",
  giteaConfig: "Destination and mirroring",
  include: "Include list",
  exclude: "Exclude list",
  scheduleConfig: "Schedule",
  cleanupConfig: "Cleanup",
  notificationConfig: "Notifications",
};

/** "giteaConfig.releaseLimit" → "Destination and mirroring: release limit". */
function describeSettingPath(path: string): string {
  const [section, ...rest] = path.split(".");
  const label = SECTION_LABELS[section] ?? section;
  if (rest.length === 0) return label;
  const words = rest
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/\burl\b/, "address"))
    .join(", ");
  return `${label}: ${words}`;
}

interface ImportResponse {
  success: boolean;
  applied?: boolean;
  summary?: SettingsImportSummary;
  message?: string;
  details?: string[];
  lock?: string;
}

async function postImport(body: Record<string, unknown>): Promise<{ status: number; data: ImportResponse }> {
  const response = await fetch(IMPORT_API_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({ success: false }))) as ImportResponse;
  return { status: response.status, data };
}

function ChangeList({
  title,
  items,
  extra,
  tone = "muted",
}: {
  title: string;
  items: string[];
  extra?: string;
  tone?: "muted" | "amber";
}) {
  if (items.length === 0 && !extra) return null;
  const shown = items.slice(0, MAX_LISTED);
  const rest = items.length - shown.length;
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{title}</span>
        <span
          className={`text-xs font-semibold tabular-nums ${tone === "amber" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}
        >
          {items.length}
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-[12px]">
          {shown.map((item, index) => (
            <li key={`${index}-${item}`} className="truncate" title={item}>
              {item}
            </li>
          ))}
          {rest > 0 && <li className="pt-1 text-muted-foreground">and {rest} more</li>}
        </ul>
      )}
      {extra && <p className="text-[12px] text-muted-foreground">{extra}</p>}
    </div>
  );
}

function rowLine(row: { name: string; changes: string[] }): string {
  return row.changes.length > 0 ? `${row.name}: ${row.changes.join(", ")}` : row.name;
}

function hasChanges(summary: SettingsImportSummary): boolean {
  return (
    summary.settings.length > 0 ||
    summary.sources.added.length > 0 ||
    summary.sources.updated.length > 0 ||
    summary.organizations.updated.length > 0 ||
    summary.repositories.updated.length > 0
  );
}

function SummaryView({ summary, applied }: { summary: SettingsImportSummary; applied: boolean }) {
  const unchanged = (count: number) => (count > 0 ? `${count} already match` : undefined);
  const todo =
    summary.todo.length > 0 ? (
      <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <p className="text-sm font-medium">{applied ? "Left to do" : "After the import"}</p>
        <ul className="list-disc space-y-1 pl-4 text-[12px] text-muted-foreground">
          {summary.todo.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="min-w-0 space-y-4">
      {/* Once imported, what is left to do matters more than what changed. */}
      {applied && todo}
      {!hasChanges(summary) && (
        <p className="text-sm text-muted-foreground">
          {applied ? "Nothing needed to change." : "This instance already matches the file."}
        </p>
      )}
      <ChangeList title="Settings" items={summary.settings.map(describeSettingPath)} />
      <ChangeList
        title="Sources"
        items={[
          ...summary.sources.added.map((s) => `${s.name}: ${applied ? "added" : "to add"}${s.enabled ? "" : ", turned off"}`),
          ...summary.sources.updated.map(rowLine),
        ]}
        extra={unchanged(summary.sources.unchanged)}
      />
      <ChangeList
        title="Organizations"
        items={summary.organizations.updated.map(rowLine)}
        extra={unchanged(summary.organizations.unchanged)}
      />
      <ChangeList
        title="Repositories"
        items={summary.repositories.updated.map(rowLine)}
        extra={unchanged(summary.repositories.unchanged)}
      />
      <ChangeList
        title="Not on this instance yet"
        items={[...summary.organizations.notFound, ...summary.repositories.notFound].map((row) => row.name)}
        tone="amber"
      />
      {!applied && todo}
      <ChangeList title="Not imported" items={summary.skipped} />
    </div>
  );
}

interface ImportSettingsDialogProps {
  /** Called after an import changed something, to reload the page's settings. */
  onImported: () => void | Promise<void>;
}

/**
 * Reads a settings file from "Export settings" back in (#587): pick the file,
 * see what would change, then apply it. The server does the work and the
 * checks; the dialog only shows the preview and the result.
 */
export function ImportSettingsDialog({ onImported }: ImportSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [file, setFile] = useState<unknown>(null);
  const [summary, setSummary] = useState<SettingsImportSummary | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDestination, setConfirmDestination] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFileName(null);
    setFile(null);
    setSummary(null);
    setApplied(false);
    setError(null);
    setConfirmDestination(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const preview = async (picked: File) => {
    reset();
    setFileName(picked.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await picked.text());
    } catch {
      setError({ message: "This file is not JSON. Choose a file made with Export settings.", details: [] });
      return;
    }
    setFile(parsed);
    setLoading(true);
    try {
      const { data } = await postImport({ file: parsed });
      if (!data.success || !data.summary) {
        setError({ message: data.message || "The file could not be read.", details: data.details ?? [] });
        return;
      }
      setSummary(data.summary);
    } catch {
      setError({ message: "Could not reach the server.", details: [] });
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const { status, data } = await postImport({
        file,
        apply: true,
        confirmDestinationChange: confirmDestination,
      });
      if (status === 409 && data.summary) {
        setSummary(data.summary);
        return;
      }
      if (!data.success || !data.summary) {
        setError({ message: data.message || "The import failed.", details: data.details ?? [] });
        return;
      }
      setSummary(data.summary);
      setApplied(true);
      toast.success("Settings imported", {
        description:
          data.summary.todo.length > 0 ? "Some things are left to do, listed in the dialog." : undefined,
      });
      await onImported();
    } catch {
      setError({ message: "Could not reach the server.", details: [] });
    } finally {
      setLoading(false);
    }
  };

  const lock = summary?.destinationLock ?? null;
  const canApply = !!summary && !applied && hasChanges(summary) && (!lock || confirmDestination);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        title="Restore settings from a file made with Export settings"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Upload className="mr-2 h-4 w-4" />
        Import settings
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (loading) return;
          setOpen(next);
        }}
      >
        {/* Header and buttons stay in view; only the middle scrolls. */}
        <DialogContent className="flex max-h-[min(90vh,52rem)] flex-col sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Import settings</DialogTitle>
            <DialogDescription>
              Restore settings, sources and organization and repository choices from a file made with Export
              settings. You will see what changes before anything is saved. Tokens are not in the file, so you
              enter those again.
            </DialogDescription>
          </DialogHeader>

          <div className="-mx-6 min-h-0 flex-1 space-y-4 overflow-y-auto px-6">
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              id="import-settings-file"
              onChange={(event) => {
                const picked = event.target.files?.[0];
                if (picked) void preview(picked);
              }}
            />

            {!fileName && (
              <label
                htmlFor="import-settings-file"
                className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 px-4 py-8 text-center text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/40"
              >
                <FileJson className="h-6 w-6" />
                <span>
                  <span className="font-medium text-foreground">Choose a settings file</span>
                  <span className="block text-[12px]">gitea-mirror-settings-….json</span>
                </span>
              </label>
            )}

            {fileName && (
              <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <FileJson className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate" title={fileName}>
                    {fileName}
                  </span>
                </span>
                {!applied && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto shrink-0 p-0 text-xs"
                    disabled={loading}
                    onClick={() => inputRef.current?.click()}
                  >
                    Choose another
                  </Button>
                )}
              </div>
            )}

            {loading && !summary && (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Reading the file…
              </div>
            )}

            {error && (
              <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-600 dark:text-rose-500">
                <p>{error.message}</p>
                {error.details.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 font-mono text-[12px]">
                    {error.details.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {applied && (
              <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-500">
                <CircleCheck className="h-4 w-4" />
                Imported.
              </p>
            )}

            {summary && <SummaryView summary={summary} applied={applied} />}

            {summary && lock && !applied && (
              <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="flex items-start gap-2 text-sm">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
                  {lock}
                </p>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={confirmDestination}
                    onCheckedChange={(checked) => setConfirmDestination(checked === true)}
                    disabled={loading}
                  />
                  Switch the destination anyway
                </label>
              </div>
            )}
          </div>

          <DialogFooter>
            {applied ? (
              <Button type="button" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={loading}>
                  Cancel
                </Button>
                <Button type="button" onClick={() => void apply()} disabled={loading || !canApply}>
                  {loading && summary ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                  Import
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
