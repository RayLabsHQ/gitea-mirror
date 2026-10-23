import { useEffect, useMemo, useState } from "react";
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
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { withBase } from "@/lib/base-path";
import type { MirrorOverrides, ReleaseType } from "@/lib/db/schema";
import {
  compileReleaseTagPattern,
  getMirrorOverrideGating,
  MIRROR_OVERRIDE_LABELS,
  normalizeReleaseAssetLimit,
  normalizeReleaseLimit,
  normalizeReleaseTagPatterns,
  normalizeReleaseType,
  UI_MIRROR_OVERRIDE_KEYS,
  type InheritedMirrorOptions,
  type MirrorOverrideKey,
  type OrgSelectionOverrideKey,
} from "@/lib/utils/mirror-overrides";
import { ReleaseTagRulesDialog } from "./ReleaseTagRulesDialog";

/**
 * Tri-state value for one flag in the dialog. "inherit" persists as absent,
 * which is what lets the next tier out supply the value.
 */
type TriState = "inherit" | "on" | "off";

/**
 * The release type is a choice rather than a flag, so it gets its own three
 * values: inherit plus the two kinds. "inherit" persists as absent.
 */
type ReleaseTypeChoice = "inherit" | ReleaseType;

/**
 * What the single Releases row offers. It covers both stored fields at once:
 * "off" pins the `mirrorReleases` flag false, the two kinds pin it true
 * together with a `releaseType`, and "inherit" pins neither.
 */
type ReleaseChoice = "inherit" | ReleaseType | "off";

/** How the value the row inherits is described in the hint beside its label. */
const RELEASE_TYPE_LABELS: Record<ReleaseType, string> = {
  all: "all releases",
  stable: "stable releases only",
};

type DialogOverrideKey = MirrorOverrideKey | OrgSelectionOverrideKey;

function toTriState(value: boolean | null | undefined): TriState {
  if (value === true) return "on";
  if (value === false) return "off";
  return "inherit";
}

function fromTriState(value: TriState): boolean | undefined {
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
}

/**
 * The release limit is edited as free text so the user can clear the field
 * back to "inherit" or type a multi-digit number without every intermediate
 * keystroke being rejected. Empty means inherit.
 */
function parseReleaseLimitDraft(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return normalizeReleaseLimit(Number(trimmed));
}

/** Same free-text handling for the asset limit, where 0 is a valid pin. */
function parseReleaseAssetLimitDraft(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return normalizeReleaseAssetLimit(Number(trimmed));
}

type TagPatternKey = "releaseIncludeTags" | "releaseExcludeTags";

/**
 * The stored list as the comma-separated text the box edits. An absent or
 * unusable list reads as empty, which is what "inherit" means here: an empty
 * list is not a pin, so a repository cannot clear a pattern its organization
 * set.
 */
function buildReleaseTagDraft(
  value: MirrorOverrides | null | undefined,
  key: TagPatternKey
): string {
  return (normalizeReleaseTagPatterns(value?.[key]) ?? []).join(", ");
}

/**
 * Read one tag-pattern box.
 *
 * `patterns` is what gets stored, or undefined when the box means "inherit".
 * `unusable` names the entries that would not take effect - too long, or a
 * regular expression that does not compile - so a typo is visible before saving
 * rather than silently ignored during a mirror run.
 */
function readTagPatternDraft(text: string): {
  patterns: string[] | undefined;
  unusable: string[];
} {
  const entries = text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const patterns = normalizeReleaseTagPatterns(entries) ?? [];
  const kept = new Set(patterns.map((pattern) => pattern.toLowerCase()));
  const unusable = entries.filter(
    (entry) => !kept.has(entry.toLowerCase()) || compileReleaseTagPattern(entry) === null
  );
  return { patterns: patterns.length > 0 ? patterns : undefined, unusable };
}

export interface MirrorOverridesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display name of the repo or org being edited. */
  targetName: string;
  /** "repository" or "organization", used for wording and gating rules. */
  targetKind: "repository" | "organization";
  /**
   * Database id of the repository being edited. Only a single repository has one,
   * and only with it can the tag-rule dialog show which published releases its
   * rules keep or delete.
   */
  targetId?: string | null;
  value?: MirrorOverrides | null;
  /**
   * Effective values from the tiers above this one, used to label what
   * "Inherit" actually resolves to right now. For a repository this should
   * already be global merged with its organization's overrides.
   */
  inheritedFrom?: InheritedMirrorOptions;
  inheritedLabel?: string;
  /**
   * True while the inherited values are still being fetched. The hint is
   * suppressed rather than shown wrong and then corrected.
   */
  inheritedLoading?: boolean;
  /** Repository-only: drives the starred-code-only gating. */
  isStarred?: boolean;
  starredCodeOnly?: boolean;
  /** The configured destination kind; GitHub and GitLab targets disable every toggle. */
  destinationProvider?: string | null;
  onSave: (overrides: MirrorOverrides | null) => Promise<void>;
}

export function MirrorOverridesDialog({
  open,
  onOpenChange,
  targetName,
  targetKind,
  targetId,
  value,
  inheritedFrom,
  inheritedLabel = "global settings",
  inheritedLoading = false,
  isStarred,
  starredCodeOnly,
  destinationProvider,
  onSave,
}: MirrorOverridesDialogProps) {
  // Skip forks steers which repositories an organization imports and mirrors
  // at all, so it leads the list; it is meaningless for a single repository.
  const dialogKeys = useMemo<DialogOverrideKey[]>(
    () =>
      targetKind === "organization"
        ? ["skipForks", ...UI_MIRROR_OVERRIDE_KEYS]
        : [...UI_MIRROR_OVERRIDE_KEYS],
    [targetKind]
  );

  const [draft, setDraft] = useState<Record<DialogOverrideKey, TriState>>(
    () => buildDraft(value, dialogKeys)
  );
  const [releaseLimitDraft, setReleaseLimitDraft] = useState(() =>
    buildReleaseLimitDraft(value)
  );
  const [releaseAssetLimitDraft, setReleaseAssetLimitDraft] = useState(() =>
    buildReleaseAssetLimitDraft(value)
  );
  const [releaseTypeDraft, setReleaseTypeDraft] = useState<ReleaseTypeChoice>(
    () => buildReleaseTypeDraft(value)
  );
  const [includeTagsDraft, setIncludeTagsDraft] = useState(() =>
    buildReleaseTagDraft(value, "releaseIncludeTags")
  );
  const [excludeTagsDraft, setExcludeTagsDraft] = useState(() =>
    buildReleaseTagDraft(value, "releaseExcludeTags")
  );
  const [isSaving, setIsSaving] = useState(false);
  const [tagRulesOpen, setTagRulesOpen] = useState(false);
  // The repositories an organization override covers. Its tag-rule preview needs
  // one chosen repository, so the rule dialog offers these in a picker.
  const [orgPreviewRepos, setOrgPreviewRepos] = useState<
    { id: string; label: string }[]
  >([]);

  // Re-seed whenever the dialog opens or targets a different object, so a
  // previous edit never leaks into the next one.
  useEffect(() => {
    if (open) {
      setDraft(buildDraft(value, dialogKeys));
      setReleaseLimitDraft(buildReleaseLimitDraft(value));
      setReleaseAssetLimitDraft(buildReleaseAssetLimitDraft(value));
      setReleaseTypeDraft(buildReleaseTypeDraft(value));
      setIncludeTagsDraft(buildReleaseTagDraft(value, "releaseIncludeTags"));
      setExcludeTagsDraft(buildReleaseTagDraft(value, "releaseExcludeTags"));
    }
  }, [open, value, dialogKeys]);

  // An organization override fans out over every repository it mirrors, so its
  // tag-rule preview cannot name a single destination up front. Fetch the
  // repositories it covers per open/target; the releases for whichever one the
  // user then picks come from the repository releases route.
  useEffect(() => {
    if (!open || targetKind !== "organization" || !targetId) {
      setOrgPreviewRepos([]);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          withBase(`/api/organizations/${targetId}/preview-repositories`),
          {
            signal: controller.signal,
            credentials: "include",
            headers: { Accept: "application/json" },
          }
        );
        const payload = await response.json().catch(() => null);
        const list = Array.isArray(payload?.repositories) ? payload.repositories : [];
        setOrgPreviewRepos(
          list
            .filter((entry: { id?: unknown }) => typeof entry.id === "string")
            .map((entry: { id: string; label?: unknown }) => ({
              id: entry.id,
              label: typeof entry.label === "string" ? entry.label : entry.id,
            }))
        );
      } catch {
        if (!controller.signal.aborted) setOrgPreviewRepos([]);
      }
    })();
    return () => controller.abort();
  }, [open, targetKind, targetId]);

  // What each flag currently resolves to, including the in-progress edit.
  // Drives the labels and release-limit gates so they react live as issues
  // and releases are toggled.
  const effective = useMemo(() => {
    const next: InheritedMirrorOptions = {};
    for (const key of UI_MIRROR_OVERRIDE_KEYS) {
      const pinned = fromTriState(draft[key]);
      next[key] = pinned ?? inheritedFrom?.[key] ?? false;
    }
    next.skipForks =
      fromTriState(draft.skipForks) ?? inheritedFrom?.skipForks ?? false;
    return next;
  }, [draft, inheritedFrom]);

  const gating = useMemo(
    () =>
      getMirrorOverrideGating({
        targetKind,
        isStarred,
        starredCodeOnly,
        effective,
        destinationProvider,
      }),
    [targetKind, isStarred, starredCodeOnly, effective, destinationProvider]
  );

  // What the tag-rule dialog previews. A repository override has the one row it
  // edits; an organization override has the list its picker offers, and nothing
  // until that list arrives. The global settings page never reaches this dialog.
  const previewRepositories = useMemo<
    readonly { id: string; label: string }[] | null
  >(() => {
    if (targetKind === "repository") {
      return targetId ? [{ id: targetId, label: targetName }] : null;
    }
    return orgPreviewRepos.length > 0 ? orgPreviewRepos : null;
  }, [targetKind, targetId, targetName, orgPreviewRepos]);

  const pinnedReleaseLimit = parseReleaseLimitDraft(releaseLimitDraft);
  // Non-empty text that does not parse to a usable limit (0, negative, junk).
  const releaseLimitInvalid =
    releaseLimitDraft.trim() !== "" && pinnedReleaseLimit === undefined;

  const pinnedReleaseAssetLimit = parseReleaseAssetLimitDraft(releaseAssetLimitDraft);
  const releaseAssetLimitInvalid =
    releaseAssetLimitDraft.trim() !== "" && pinnedReleaseAssetLimit === undefined;

  const pinnedReleaseType: ReleaseType | undefined =
    releaseTypeDraft === "inherit" ? undefined : normalizeReleaseType(releaseTypeDraft);

  // One control drives two stored fields. A stored "releases on" with no kind
  // pinned still reads as Inherit and keeps its pin on save, so an override set
  // before the kind filter existed is never dropped by merely opening the dialog.
  const releaseChoice: ReleaseChoice =
    draft.mirrorReleases === "off"
      ? "off"
      : releaseTypeDraft !== "inherit"
        ? releaseTypeDraft
        : "inherit";

  const applyReleaseChoice = (next: ReleaseChoice) => {
    setDraft((prev) => ({
      ...prev,
      mirrorReleases:
        next === "inherit" ? "inherit" : next === "off" ? "off" : "on",
    }));
    // "off" leaves the pinned kind alone, so switching releases back on goes
    // straight back to the kind that was set before.
    if (next !== "off") setReleaseTypeDraft(next);
  };

  const includeTags = readTagPatternDraft(includeTagsDraft);
  const excludeTags = readTagPatternDraft(excludeTagsDraft);
  const includeTagsInvalid = includeTags.unusable.length > 0;
  const excludeTagsInvalid = excludeTags.unusable.length > 0;
  const tagPatternsInvalid = includeTagsInvalid || excludeTagsInvalid;
  const unusableTagPatterns = [...includeTags.unusable, ...excludeTags.unusable];
  const tagPatternCount =
    (includeTags.patterns?.length ?? 0) + (excludeTags.patterns?.length ?? 0);

  // How many rows pin a value, which is what "Reset all" waits on. The Releases
  // row counts once even though it writes two fields.
  const overriddenCount =
    Object.entries(draft).filter(
      ([key, state]) => key !== "mirrorReleases" && state !== "inherit"
    ).length +
    (draft.mirrorReleases !== "inherit" || releaseTypeDraft !== "inherit"
      ? 1
      : 0) +
    (pinnedReleaseLimit !== undefined ? 1 : 0) +
    (pinnedReleaseAssetLimit !== undefined ? 1 : 0) +
    (includeTags.patterns !== undefined ? 1 : 0) +
    (excludeTags.patterns !== undefined ? 1 : 0);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Gated flags keep whatever the user previously stored. The clamp is a
      // runtime concern, so a disabled toggle must not silently erase data.
      const next: MirrorOverrides = {};
      for (const key of UI_MIRROR_OVERRIDE_KEYS) {
        const resolved = fromTriState(draft[key]);
        if (typeof resolved === "boolean") next[key] = resolved;
      }
      if (targetKind === "organization") {
        const resolved = fromTriState(draft.skipForks);
        if (typeof resolved === "boolean") next.skipForks = resolved;
      }
      if (pinnedReleaseLimit !== undefined) next.releaseLimit = pinnedReleaseLimit;
      if (pinnedReleaseAssetLimit !== undefined) {
        next.releaseAssetLimit = pinnedReleaseAssetLimit;
      }
      if (pinnedReleaseType !== undefined) next.releaseType = pinnedReleaseType;
      if (includeTags.patterns !== undefined) {
        next.releaseIncludeTags = includeTags.patterns;
      }
      if (excludeTags.patterns !== undefined) {
        next.releaseExcludeTags = excludeTags.patterns;
      }
      await onSave(Object.keys(next).length > 0 ? next : null);
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetAll = () => {
    setDraft(buildDraft(null, dialogKeys));
    setReleaseLimitDraft("");
    setReleaseAssetLimitDraft("");
    setReleaseTypeDraft("inherit");
    setIncludeTagsDraft("");
    setExcludeTagsDraft("");
  };

  const releaseLimitReason = gating.releaseLimit;
  const releaseLimitDisabled = !!releaseLimitReason;
  const inheritedReleaseLimit = inheritedFrom?.releaseLimit;
  // Only while the field is genuinely empty: an invalid entry gets the error
  // line instead, so "currently 10" is not shown next to a rejected "0".
  const showReleaseLimitHint =
    !inheritedLoading &&
    !releaseLimitDisabled &&
    releaseLimitDraft.trim() === "" &&
    inheritedReleaseLimit !== undefined;

  const releaseAssetLimitReason = gating.releaseAssetLimit;
  const releaseAssetLimitDisabled = !!releaseAssetLimitReason;
  // null is a known value here ("all"), so it still earns a hint.
  const inheritedReleaseAssetLimit = inheritedFrom?.releaseAssetLimit;
  const showReleaseAssetLimitHint =
    !inheritedLoading &&
    !releaseAssetLimitDisabled &&
    releaseAssetLimitDraft.trim() === "" &&
    inheritedReleaseAssetLimit !== undefined;

  // The Releases row is only locked by a tier-level clamp: the starred setting,
  // a push destination, or a source with no releases. Choosing "Off" here must
  // not disable the row, or the choice could never be undone.
  const releasesRowReason = gating.mirrorReleases;
  const releasesRowDisabled = !!releasesRowReason;
  // What the row resolves to while it inherits: the kind the tiers above pin,
  // which the runtime defaults to "all" when nothing names one. The tag-rule
  // preview needs it, because the retention pass applies the type filter and
  // the tag patterns together when it decides what stays in the destination.
  const effectiveReleaseType: ReleaseType =
    pinnedReleaseType ?? inheritedFrom?.releaseType ?? "all";
  const showReleasesHint =
    !inheritedLoading && !releasesRowDisabled && releaseChoice === "inherit";
  const releasesHintText = effective.mirrorReleases
    ? RELEASE_TYPE_LABELS[effectiveReleaseType]
    : "off";

  // Both boxes are gated by the same condition (they narrow the release filter),
  // so one reason covers the pair.
  const releaseTagsReason = gating.releaseIncludeTags ?? gating.releaseExcludeTags;
  const releaseTagsDisabled = !!releaseTagsReason;
  // An empty inherited list is no filter, so it is not worth a hint; only a list
  // that is actually filtering gets named beside the empty box.
  const inheritedIncludeTagText =
    inheritedFrom?.releaseIncludeTags && inheritedFrom.releaseIncludeTags.length > 0
      ? inheritedFrom.releaseIncludeTags.join(", ")
      : undefined;
  const inheritedExcludeTagText =
    inheritedFrom?.releaseExcludeTags && inheritedFrom.releaseExcludeTags.length > 0
      ? inheritedFrom.releaseExcludeTags.join(", ")
      : undefined;
  // The two lists are edited together in one dialog, so the inherited rules are
  // named as a single hint: "only v*, except *-rc.*". An empty inherited list is
  // no filter, so it is not worth naming.
  const inheritedTagText = [
    inheritedIncludeTagText ? `only ${inheritedIncludeTagText}` : null,
    inheritedExcludeTagText ? `except ${inheritedExcludeTagText}` : null,
  ]
    .filter((text): text is string => !!text)
    .join(", ");
  const showTagsHint =
    !inheritedLoading &&
    !releaseTagsDisabled &&
    tagPatternCount === 0 &&
    inheritedTagText !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mirror options</DialogTitle>
          <DialogDescription>
            Override what gets mirrored for this {targetKind}.{" "}
            <span className="font-medium text-foreground">{targetName}</span>{" "}
            inherits anything left on Inherit.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[62vh] overflow-y-auto pr-1">
          <div className="space-y-3">
            {dialogKeys.map((key) => {
              // Everything release related is grouped under the Releases row,
              // so the limits and the tag rules never drift away from the
              // filter they narrow.
              if (key === "mirrorReleases") {
                return (
                  <div key={key} className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-4">
                        <Label
                          htmlFor="override-releases"
                          className={
                            releasesRowDisabled
                              ? "flex-1 text-muted-foreground"
                              : "flex-1"
                          }
                        >
                          {MIRROR_OVERRIDE_LABELS.mirrorReleases}
                          {showReleasesHint && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              currently {releasesHintText}
                            </span>
                          )}
                        </Label>
                        <Select
                          value={releaseChoice}
                          disabled={releasesRowDisabled}
                          onValueChange={(next) =>
                            applyReleaseChoice(next as ReleaseChoice)
                          }
                        >
                          <SelectTrigger id="override-releases" className="w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">Inherit</SelectItem>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="stable">Stable only</SelectItem>
                            <SelectItem value="off">Off</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {releasesRowReason && (
                        <p className="text-xs text-muted-foreground">
                          {releasesRowReason}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-4">
                        <Label
                          htmlFor="override-releaseLimit"
                          className={
                            releaseLimitDisabled
                              ? "flex-1 text-muted-foreground"
                              : "flex-1"
                          }
                        >
                          {MIRROR_OVERRIDE_LABELS.releaseLimit}
                          {showReleaseLimitHint && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              currently {inheritedReleaseLimit}
                            </span>
                          )}
                        </Label>
                        <Input
                          id="override-releaseLimit"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          step={1}
                          placeholder="Inherit"
                          className="w-32"
                          value={releaseLimitDraft}
                          disabled={releaseLimitDisabled}
                          aria-invalid={releaseLimitInvalid || undefined}
                          onChange={(event) =>
                            setReleaseLimitDraft(event.target.value)
                          }
                        />
                      </div>
                      {!releaseLimitDisabled && releaseLimitInvalid && (
                        <p className="text-xs text-destructive">
                          Enter a whole number of 1 or more, or leave it empty to
                          inherit.
                        </p>
                      )}
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-4">
                        <Label
                          htmlFor="override-releaseAssetLimit"
                          className={
                            releaseAssetLimitDisabled
                              ? "flex-1 text-muted-foreground"
                              : "flex-1"
                          }
                        >
                          {MIRROR_OVERRIDE_LABELS.releaseAssetLimit}
                          {showReleaseAssetLimitHint && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              currently{" "}
                              {inheritedReleaseAssetLimit === null
                                ? "all"
                                : inheritedReleaseAssetLimit}
                            </span>
                          )}
                        </Label>
                        <Input
                          id="override-releaseAssetLimit"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          step={1}
                          placeholder="Inherit"
                          className="w-32"
                          value={releaseAssetLimitDraft}
                          disabled={releaseAssetLimitDisabled}
                          aria-invalid={releaseAssetLimitInvalid || undefined}
                          onChange={(event) =>
                            setReleaseAssetLimitDraft(event.target.value)
                          }
                        />
                      </div>
                      {!releaseAssetLimitDisabled && releaseAssetLimitInvalid && (
                        <p className="text-xs text-destructive">
                          Enter a whole number of 0 or more, or leave it empty to
                          inherit.
                        </p>
                      )}
                    </div>

                    {/* Tag patterns narrow the kind filter further, for upstreams
                        that never set the pre-release flag but tag v1.2.3-rc.1. */}
                    <div className="space-y-1">
                      <button
                        id="override-tag-rules"
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2 text-left transition-colors hover:bg-muted",
                          releaseTagsDisabled && "cursor-not-allowed opacity-60"
                        )}
                        disabled={releaseTagsDisabled}
                        onClick={() => setTagRulesOpen(true)}
                      >
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="text-sm font-medium">Custom tag rules</span>
                        <span className="text-xs text-muted-foreground">
                          optional
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {tagPatternCount > 0
                            ? `${tagPatternCount} set`
                            : showTagsHint
                              ? `currently ${inheritedTagText}`
                              : "none set"}
                        </span>
                      </button>
                      {releaseTagsReason ? (
                        <p className="text-xs text-muted-foreground">
                          {releaseTagsReason}
                        </p>
                      ) : tagPatternsInvalid ? (
                        <p className="text-xs text-destructive">
                          {unusableTagPatterns.join(", ")} cannot be used as a tag
                          pattern.
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              }

              const disabledReason = gating[key];
              const isDisabled = !!disabledReason;
              const inherited =
                key === "skipForks" ? inheritedFrom?.skipForks : inheritedFrom?.[key];
              const showHint =
                !inheritedLoading &&
                !isDisabled &&
                draft[key] === "inherit" &&
                inherited !== undefined;

              return (
                <div key={key} className="space-y-1">
                  <div className="flex items-center justify-between gap-4">
                    <Label
                      htmlFor={`override-${key}`}
                      className={isDisabled ? "flex-1 text-muted-foreground" : "flex-1"}
                    >
                      {MIRROR_OVERRIDE_LABELS[key]}
                      {showHint && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          currently {inherited ? "on" : "off"}
                        </span>
                      )}
                    </Label>
                    <Select
                      value={draft[key]}
                      disabled={isDisabled}
                      onValueChange={(next) =>
                        setDraft((prev) => ({ ...prev, [key]: next as TriState }))
                      }
                    >
                      <SelectTrigger id={`override-${key}`} className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">Inherit</SelectItem>
                        <SelectItem value="on">On</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {isDisabled && (
                    <p className="text-xs text-muted-foreground">
                      {disabledReason}
                    </p>
                  )}
                </div>
              );
            })}

            <p className="text-xs text-muted-foreground">
              Inherit uses the {inheritedLabel}.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="ghost"
            onClick={handleResetAll}
            disabled={isSaving || overriddenCount === 0}
          >
            Reset all
          </Button>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              isSaving ||
              releaseLimitInvalid ||
              releaseAssetLimitInvalid ||
              includeTagsInvalid ||
              excludeTagsInvalid
            }
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>

        {/* Nested on purpose: the pattern syntax needs more room than this
            compact override dialog has. */}
        <ReleaseTagRulesDialog
          open={tagRulesOpen}
          onOpenChange={setTagRulesOpen}
          includeTags={includeTags.patterns ?? []}
          excludeTags={excludeTags.patterns ?? []}
          previewRepositories={previewRepositories}
          releaseType={effectiveReleaseType}
          onSave={(include, exclude) => {
            setIncludeTagsDraft(include.join(", "));
            setExcludeTagsDraft(exclude.join(", "));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function buildDraft(
  value: MirrorOverrides | null | undefined,
  keys: readonly DialogOverrideKey[]
): Record<DialogOverrideKey, TriState> {
  const draft = {} as Record<DialogOverrideKey, TriState>;
  for (const key of keys) {
    draft[key] = toTriState(value?.[key]);
  }
  return draft;
}

function buildReleaseLimitDraft(
  value: MirrorOverrides | null | undefined
): string {
  const limit = normalizeReleaseLimit(value?.releaseLimit);
  return limit === undefined ? "" : String(limit);
}

function buildReleaseAssetLimitDraft(
  value: MirrorOverrides | null | undefined
): string {
  const limit = normalizeReleaseAssetLimit(value?.releaseAssetLimit);
  return limit === undefined ? "" : String(limit);
}

/** An unusable stored value reads as inherit, matching how the resolver treats it. */
function buildReleaseTypeDraft(
  value: MirrorOverrides | null | undefined
): ReleaseTypeChoice {
  return normalizeReleaseType(value?.releaseType) ?? "inherit";
}
