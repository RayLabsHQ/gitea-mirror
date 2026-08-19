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
  MIRROR_OVERRIDE_LABELS,
  UI_MIRROR_OVERRIDE_KEYS,
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

export interface MirrorOverridesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display name of the repo or org being edited. */
  targetName: string;
  /** "repository" or "organization", used for the wording only. */
  targetKind: "repository" | "organization";
  value?: MirrorOverrides | null;
  /**
   * Effective values from the tiers above this one, used to label what
   * "Inherit" actually resolves to right now.
   */
  inheritedFrom?: Partial<Record<MirrorOverrideKey, boolean>>;
  inheritedLabel?: string;
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
  onSave,
}: MirrorOverridesDialogProps) {
  const [draft, setDraft] = useState<Record<MirrorOverrideKey, TriState>>(
    () => buildDraft(value)
  );
  const [isSaving, setIsSaving] = useState(false);

  // Re-seed whenever the dialog opens or targets a different object, so a
  // previous edit never leaks into the next one.
  useEffect(() => {
    if (open) setDraft(buildDraft(value));
  }, [open, value]);

  const overriddenCount = useMemo(
    () => Object.values(draft).filter((state) => state !== "inherit").length,
    [draft]
  );

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const next: MirrorOverrides = {};
      for (const key of UI_MIRROR_OVERRIDE_KEYS) {
        const resolved = fromTriState(draft[key]);
        if (typeof resolved === "boolean") next[key] = resolved;
      }
      await onSave(Object.keys(next).length > 0 ? next : null);
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetAll = () => {
    setDraft(buildDraft(null));
  };

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
            const inherited = inheritedFrom?.[key];
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-4"
              >
                <Label htmlFor={`override-${key}`} className="flex-1">
                  {MIRROR_OVERRIDE_LABELS[key]}
                  {inherited !== undefined && draft[key] === "inherit" && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      currently {inherited ? "on" : "off"}
                    </span>
                  )}
                </Label>
                <Select
                  value={draft[key]}
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
          <Button onClick={handleSave} disabled={isSaving}>
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
