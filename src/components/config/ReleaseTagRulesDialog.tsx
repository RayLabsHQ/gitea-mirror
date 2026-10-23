import { useEffect, useState } from "react";
import { Check, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  compileReleaseTagPattern,
  compileReleaseTagPatterns,
  MAX_RELEASE_TAG_PATTERNS,
  MAX_RELEASE_TAG_PATTERN_LENGTH,
  normalizeReleaseTagPatterns,
  releaseMatchesTagFilters,
  releaseMatchesType,
  splitReleaseTagEntries,
} from "@/lib/utils/mirror-overrides";
import type { ReleaseType } from "@/lib/db/schema";
import { withBase } from "@/lib/base-path";

/** A release the destination already holds for the repository being edited. */
type PublishedRelease = {
  tag: string;
  prerelease: boolean | null;
};

/**
 * One repository the rule can be previewed against. A repository override offers
 * exactly one; an organization override offers every repository it covers, and
 * the picker lets the user choose which one the preview runs against.
 */
type PreviewRepository = {
  id: string;
  label: string;
};

type PreviewState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      destination: string;
      releases: PublishedRelease[];
      truncated: boolean;
    };

/**
 * One tag-rule box read as text.
 *
 * `patterns` is what gets stored. `unusable` names the entries that would never
 * take effect - too long, past the count cap, or a regular expression that does
 * not compile - so a typo is visible here instead of being silently dropped
 * during a mirror run.
 */
function readTagRuleDraft(text: string): { patterns: string[]; unusable: string[] } {
  // Commas inside /.../ belong to the regex, not to the list.
  const entries = splitReleaseTagEntries(text);
  const patterns = normalizeReleaseTagPatterns(entries) ?? [];
  const kept = new Set(patterns.map((pattern) => pattern.toLowerCase()));
  const unusable = entries.filter(
    (entry) => !kept.has(entry.toLowerCase()) || compileReleaseTagPattern(entry) === null
  );
  return { patterns, unusable };
}

export interface ReleaseTagRulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  includeTags?: readonly string[] | null;
  excludeTags?: readonly string[] | null;
  /** An empty list means that side does not filter. */
  onSave: (includeTags: string[], excludeTags: string[]) => void;
  /**
   * Repositories whose published releases the draft rules can be checked
   * against. When set, the dialog lists what the destination already holds and
   * marks the releases a save keeps and the ones the next sync would delete. A
   * repository override passes the single repository it edits; an organization
   * override passes every repository it covers and the dialog adds a picker so
   * the user previews one of them. It is left out where nothing single applies:
   * the global settings cover every repository at once.
   */
  previewRepositories?: readonly PreviewRepository[] | null;
  /**
   * The release type this repository ends up with. The retention pass applies the
   * type filter and the tag patterns together, so the preview would be wrong if
   * it only looked at the patterns. Defaults to "all" (no type filter).
   */
  releaseType?: ReleaseType;
}

/**
 * The tag patterns that narrow which releases are mirrored. They live in a
 * dialog rather than inline on the settings page because the syntax needs room
 * to explain itself; the page only shows how many rules are set.
 */
export function ReleaseTagRulesDialog({
  open,
  onOpenChange,
  includeTags,
  excludeTags,
  onSave,
  previewRepositories,
  releaseType = "all",
}: ReleaseTagRulesDialogProps) {
  const [includeText, setIncludeText] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Which repository the preview runs against. An organization override offers
  // several; a repository override has only the one it edits.
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);

  // Re-seeded on every open so a config change elsewhere cannot be overwritten
  // by a draft left over from a previous visit.
  useEffect(() => {
    if (!open) return;
    setIncludeText((normalizeReleaseTagPatterns(includeTags) ?? []).join(", "));
    setExcludeText((normalizeReleaseTagPatterns(excludeTags) ?? []).join(", "));
  }, [open, includeTags, excludeTags]);

  // The published releases are read once per open. Judging them against the rules
  // happens in the browser, so editing a pattern afterwards costs no request.
  useEffect(() => {
    if (!open || !selectedRepoId) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    setPreview({ status: "loading" });
    void (async () => {
      try {
        const response = await fetch(
          withBase(`/api/repositories/${selectedRepoId}/releases`),
          {
            signal: controller.signal,
            credentials: "include",
            headers: { Accept: "application/json" },
          }
        );
        const payload = await response.json().catch(() => null);
        const data = payload?.data ?? payload;
        if (!response.ok || data?.success === false) {
          setPreview({
            status: "error",
            error:
              typeof data?.error === "string" ? data.error : `Request failed (${response.status})`,
          });
          return;
        }
        setPreview({
          status: "ready",
          destination: typeof data?.destination === "string" ? data.destination : "",
          releases: Array.isArray(data?.releases) ? data.releases : [],
          truncated: data?.truncated === true,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPreview({
          status: "error",
          error: error instanceof Error ? error.message : "The destination could not be reached",
        });
      }
    })();
    return () => controller.abort();
  }, [open, selectedRepoId]);

  // Keep the selection pointed at a repository that is actually offered. Opening
  // a different organization, or one whose repository list changed, drops a
  // stale selection back to the first entry.
  useEffect(() => {
    if (!open) return;
    const offered = previewRepositories ?? [];
    setSelectedRepoId((previous) =>
      previous && offered.some((repository) => repository.id === previous)
        ? previous
        : (offered[0]?.id ?? null)
    );
  }, [open, previewRepositories]);

  const include = readTagRuleDraft(includeText);
  const exclude = readTagRuleDraft(excludeText);
  const unusable = [
    ...include.unusable.map((pattern) => `Include: ${pattern}`),
    ...exclude.unusable.map((pattern) => `Exclude: ${pattern}`),
  ];

  // Re-run what the retention pass does to the destination: a published release
  // stays when its tag passes the patterns and - only where the destination
  // reported a pre-release flag - the type filter as well. An unknown flag is
  // never guessed at, exactly as in a mirror run.
  const kept: string[] = [];
  const removed: string[] = [];
  if (preview?.status === "ready") {
    const includePatterns = compileReleaseTagPatterns(include.patterns);
    const excludePatterns = compileReleaseTagPatterns(exclude.patterns);
    for (const release of preview.releases) {
      const survives =
        releaseMatchesTagFilters(release.tag, includePatterns, excludePatterns) &&
        (releaseType === "all" ||
          typeof release.prerelease !== "boolean" ||
          releaseMatchesType({ prerelease: release.prerelease }, releaseType));
      (survives ? kept : removed).push(release.tag);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Custom release tag rules</DialogTitle>
          <DialogDescription>
            Narrow which releases are mirrored by their tag name. An excluded tag
            wins when both lists name it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="tag-rules-include">Include tags</Label>
            <Input
              id="tag-rules-include"
              type="text"
              placeholder="v*, release-*"
              value={includeText}
              onChange={(e) => setIncludeText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              When set, only releases whose tag matches one of these are mirrored.
              Empty means no include filter.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="tag-rules-exclude">Exclude tags</Label>
            <Input
              id="tag-rules-exclude"
              type="text"
              placeholder="*-rc.*, *-alpha.*, *-next.*"
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Releases whose tag matches one of these are skipped, even when an
              include pattern matches. Empty means no exclude filter.
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            Patterns are matched against the whole tag name, ignoring case:{" "}
            <code className="rounded bg-muted px-1 py-0.5">v1.*</code> matches v1.4
            and v1.4.0, <code className="rounded bg-muted px-1 py-0.5">?</code> is
            exactly one character, and{" "}
            <code className="rounded bg-muted px-1 py-0.5">/^\d+\.\d+$/</code> is a
            regular expression. Up to {MAX_RELEASE_TAG_PATTERNS} patterns of{" "}
            {MAX_RELEASE_TAG_PATTERN_LENGTH} characters each. Releases already in
            Gitea that stop matching are removed on the next sync.
          </p>

          {previewRepositories && previewRepositories.length > 0 ? (
            <div className="space-y-2 rounded-md border p-3">
              {previewRepositories.length > 1 ? (
                <div className="space-y-1">
                  <Label htmlFor="tag-rules-preview-repo">Preview repository</Label>
                  <Select
                    value={selectedRepoId ?? ""}
                    onValueChange={(next) => setSelectedRepoId(next)}
                  >
                    <SelectTrigger id="tag-rules-preview-repo" className="w-full">
                      <SelectValue placeholder="Choose a repository" />
                    </SelectTrigger>
                    <SelectContent>
                      {previewRepositories.map((repository) => (
                        <SelectItem key={repository.id} value={repository.id}>
                          {repository.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Already in Gitea</span>
                {preview?.status === "ready" && preview.releases.length > 0 ? (
                  <span
                    className={cn(
                      "text-xs",
                      removed.length > 0 ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {removed.length === 0
                      ? `all ${kept.length} kept`
                      : `${removed.length} of ${preview.releases.length} would be removed`}
                  </span>
                ) : null}
              </div>

              {preview?.status === "loading" ? (
                <p className="text-xs text-muted-foreground">Checking the destination…</p>
              ) : null}

              {preview?.status === "error" ? (
                <p className="text-xs text-destructive">{preview.error}</p>
              ) : null}

              {preview?.status === "ready" && preview.releases.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {preview.destination
                    ? `Nothing is published in ${preview.destination} yet.`
                    : "Nothing is published there yet."}
                </p>
              ) : null}

              {preview?.status === "ready" && preview.releases.length > 0 ? (
                <>
                  <div className="grid max-h-40 gap-x-3 gap-y-1 overflow-y-auto pr-1 sm:grid-cols-2">
                    {removed.map((tag) => (
                      <div key={tag} className="flex items-center gap-2 text-xs">
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                        <span className="truncate font-mono text-muted-foreground line-through">
                          {tag}
                        </span>
                      </div>
                    ))}
                    {kept.map((tag) => (
                      <div key={tag} className="flex items-center gap-2 text-xs">
                        <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                        <span className="truncate font-mono">{tag}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The destination is checked against these rules on every sync, so a
                    crossed-out release is deleted the next time this repository syncs.
                    {preview.truncated
                      ? ` Only the newest ${preview.releases.length} published releases are listed.`
                      : ""}
                  </p>
                </>
              ) : null}
            </div>
          ) : null}

          {unusable.length > 0 && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Cannot be used: {unusable.join(", ")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(include.patterns, exclude.patterns);
              onOpenChange(false);
            }}
            disabled={unusable.length > 0}
          >
            Save rules
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
