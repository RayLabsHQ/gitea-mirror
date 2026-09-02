import { Fragment, useEffect, useMemo, useState } from "react";
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
import type { MirrorOverrides } from "@/lib/db/schema";
import {
  getMirrorOverrideGating,
  MIRROR_OVERRIDE_LABELS,
  normalizeReleaseAssetLimit,
  normalizeReleaseLimit,
  UI_MIRROR_OVERRIDE_KEYS,
  type InheritedMirrorOptions,
  type MirrorOverrideKey,
} from "@/lib/utils/mirror-overrides";

/**
 * Tri-state value for one flag in the dialog. "inherit" persists as absent,
 * which is what lets the next tier out supply the value.
 */
type TriState = "inherit" | "on" | "off";

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

export interface MirrorOverridesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display name of the repo or org being edited. */
  targetName: string;
  /** "repository" or "organization", used for wording and gating rules. */
  targetKind: "repository" | "organization";
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
  value,
  inheritedFrom,
  inheritedLabel = "global settings",
  inheritedLoading = false,
  isStarred,
  starredCodeOnly,
  destinationProvider,
  onSave,
}: MirrorOverridesDialogProps) {
  const [draft, setDraft] = useState<Record<MirrorOverrideKey, TriState>>(
    () => buildDraft(value)
  );
  const [releaseLimitDraft, setReleaseLimitDraft] = useState(() =>
    buildReleaseLimitDraft(value)
  );
  const [releaseAssetLimitDraft, setReleaseAssetLimitDraft] = useState(() =>
    buildReleaseAssetLimitDraft(value)
  );
  const [isSaving, setIsSaving] = useState(false);

  // Re-seed whenever the dialog opens or targets a different object, so a
  // previous edit never leaks into the next one.
  useEffect(() => {
    if (open) {
      setDraft(buildDraft(value));
      setReleaseLimitDraft(buildReleaseLimitDraft(value));
      setReleaseAssetLimitDraft(buildReleaseAssetLimitDraft(value));
    }
  }, [open, value]);

  // What each flag currently resolves to, including the in-progress edit.
  // Drives the labels and release-limit gates so they react live as issues
  // and releases are toggled.
  const effective = useMemo(() => {
    const next: InheritedMirrorOptions = {};
    for (const key of UI_MIRROR_OVERRIDE_KEYS) {
      const pinned = fromTriState(draft[key]);
      next[key] = pinned ?? inheritedFrom?.[key] ?? false;
    }
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

  const pinnedReleaseLimit = parseReleaseLimitDraft(releaseLimitDraft);
  // Non-empty text that does not parse to a usable limit (0, negative, junk).
  const releaseLimitInvalid =
    releaseLimitDraft.trim() !== "" && pinnedReleaseLimit === undefined;

  const pinnedReleaseAssetLimit = parseReleaseAssetLimitDraft(releaseAssetLimitDraft);
  const releaseAssetLimitInvalid =
    releaseAssetLimitDraft.trim() !== "" && pinnedReleaseAssetLimit === undefined;

  const overriddenCount = useMemo(
    () =>
      Object.values(draft).filter((state) => state !== "inherit").length +
      (pinnedReleaseLimit !== undefined ? 1 : 0) +
      (pinnedReleaseAssetLimit !== undefined ? 1 : 0),
    [draft, pinnedReleaseLimit, pinnedReleaseAssetLimit]
  );

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
      if (pinnedReleaseLimit !== undefined) next.releaseLimit = pinnedReleaseLimit;
      if (pinnedReleaseAssetLimit !== undefined) {
        next.releaseAssetLimit = pinnedReleaseAssetLimit;
      }
      await onSave(Object.keys(next).length > 0 ? next : null);
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetAll = () => {
    setDraft(buildDraft(null));
    setReleaseLimitDraft("");
    setReleaseAssetLimitDraft("");
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

        <div className="space-y-3 py-2">
          {UI_MIRROR_OVERRIDE_KEYS.map((key) => {
            const disabledReason = gating[key];
            const isDisabled = !!disabledReason;
            const inherited = inheritedFrom?.[key];
            const showHint =
              !inheritedLoading &&
              !isDisabled &&
              draft[key] === "inherit" &&
              inherited !== undefined;

            return (
              <Fragment key={key}>
                <div className="space-y-1">
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

                {/* The limits only mean something while releases are mirrored,
                    so they sit directly under that row. */}
                {key === "mirrorReleases" && (
                  <>
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
                        onChange={(event) => setReleaseLimitDraft(event.target.value)}
                      />
                    </div>
                    {releaseLimitDisabled ? (
                      <p className="text-xs text-muted-foreground">
                        {releaseLimitReason}
                      </p>
                    ) : releaseLimitInvalid ? (
                      <p className="text-xs text-destructive">
                        Enter a whole number of 1 or more, or leave it empty to
                        inherit.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Newest releases to keep. Older ones past the limit are
                        removed from Gitea on the next sync.
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
                    {releaseAssetLimitDisabled ? (
                      <p className="text-xs text-muted-foreground">
                        {releaseAssetLimitReason}
                      </p>
                    ) : releaseAssetLimitInvalid ? (
                      <p className="text-xs text-destructive">
                        Enter a whole number of 0 or more, or leave it empty to
                        inherit.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Assets are uploaded only for this many of the newest
                        releases; 0 keeps release notes only. Assets already in
                        Gitea are never removed.
                      </p>
                    )}
                  </div>
                  </>
                )}
              </Fragment>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          Inherit uses the {inheritedLabel}. Git LFS is worth turning off for
          repositories whose LFS fetch fails, since Gitea aborts the whole
          migration when it cannot pull them.
        </p>

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
            disabled={isSaving || releaseLimitInvalid || releaseAssetLimitInvalid}
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function buildDraft(
  value: MirrorOverrides | null | undefined
): Record<MirrorOverrideKey, TriState> {
  const draft = {} as Record<MirrorOverrideKey, TriState>;
  for (const key of UI_MIRROR_OVERRIDE_KEYS) {
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
