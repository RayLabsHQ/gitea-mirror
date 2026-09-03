import { useState } from "react";
import { ArrowRight, Edit3, RotateCcw, CheckCircle2, Building2, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { OrganizationMoveResult } from "@/lib/destination-transfer";

interface MirrorDestinationEditorProps {
  organizationId: string;
  organizationName: string;
  currentDestination?: string;
  onUpdate: (newDestination: string | null) => Promise<void>;
  /**
   * Plan (dryRun) or perform the move of the organization's mirrors on the
   * destination (issue #400). Absent when the destination cannot move
   * repositories, which hides the option.
   */
  onMoveMirrors?: (newDestination: string | null, dryRun: boolean) => Promise<OrganizationMoveResult>;
  /** "Gitea" or "Forgejo", for the copy. */
  destinationLabel?: string;
  isUpdating?: boolean;
  className?: string;
}

const MAX_LISTED = 8;

function MoveList({ title, items }: { title: string; items: string[] }) {
  const shown = items.slice(0, MAX_LISTED);
  const rest = items.length - shown.length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs font-semibold tabular-nums text-muted-foreground">{items.length}</span>
      </div>
      <ul className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[12px]">
        {shown.map((item) => (
          <li key={item} className="truncate" title={item}>
            {item}
          </li>
        ))}
        {rest > 0 && <li className="pt-1 font-sans text-muted-foreground">and {rest} more</li>}
      </ul>
    </div>
  );
}

function summarizeSkipped(skipped: OrganizationMoveResult["plan"]["skipped"]): string {
  if (skipped.length === 0) return "no repository of this organization is mirrored yet";
  const counts = new Map<string, number>();
  for (const entry of skipped) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");
}

export function MirrorDestinationEditor({
  organizationId,
  organizationName,
  currentDestination,
  onUpdate,
  onMoveMirrors,
  destinationLabel = "Gitea",
  isUpdating = false,
  className,
}: MirrorDestinationEditorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [editValue, setEditValue] = useState(currentDestination || "");
  const [isLoading, setIsLoading] = useState(false);
  const [moveMirrors, setMoveMirrors] = useState(false);
  const [plan, setPlan] = useState<OrganizationMoveResult | null>(null);
  const [pendingDestination, setPendingDestination] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const hasOverride = currentDestination && currentDestination !== organizationName;
  const effectiveDestination = currentDestination || organizationName;
  const canMove = typeof onMoveMirrors === "function";

  const handleSave = async () => {
    const trimmedValue = editValue.trim();
    const newDestination = trimmedValue === "" || trimmedValue === organizationName 
      ? null 
      : trimmedValue;

    setIsLoading(true);
    try {
      if (moveMirrors && onMoveMirrors) {
        // Plan first; the confirmation shows exactly what would move.
        const preview = await onMoveMirrors(newDestination, true);
        if (preview.plan.moves.length === 0) {
          await onUpdate(newDestination);
          setIsOpen(false);
          toast.success(`Destination updated. Nothing to move: ${summarizeSkipped(preview.plan.skipped)}.`);
          return;
        }
        setPlan(preview);
        setPendingDestination(newDestination);
        setConfirmError(null);
        setIsOpen(false);
        setConfirmOpen(true);
        return;
      }

      await onUpdate(newDestination);
      setIsOpen(false);
      toast.success(
        newDestination 
          ? `Destination updated to: ${newDestination}`
          : "Destination reset to default"
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update destination");
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmMove = async () => {
    if (!onMoveMirrors) return;
    setApplying(true);
    setConfirmError(null);
    try {
      const result = await onMoveMirrors(pendingDestination, false);
      setConfirmOpen(false);
      const parts = [`moved ${result.moved.length}`];
      if (result.pending.length > 0) parts.push(`${result.pending.length} waiting for acceptance`);
      if (result.recorded.length > 0) parts.push(`${result.recorded.length} already there`);
      if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
      const summary = `Destination updated: ${parts.join(", ")}.`;
      if (result.failed.length > 0) {
        toast.error(summary, { description: result.failed[0]?.error });
      } else {
        toast.success(summary);
      }
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : "Failed to move the mirrors");
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setEditValue("");
    await handleSave();
  };

  const handleCancel = () => {
    setEditValue(currentDestination || "");
    setIsOpen(false);
  };

  const moveCount = plan?.plan.moves.length ?? 0;
  const targetOwners = Array.from(
    new Set((plan?.plan.moves ?? []).map((entry) => entry.to.slice(0, entry.to.indexOf("/"))))
  );
  const targetLabel = pendingDestination ?? (targetOwners.length === 1 ? targetOwners[0] : "their default owner");

  return (
    <div className={cn("flex items-center gap-2 w-full", className)}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 flex-1">
        <Building2 className="h-3 w-3 flex-shrink-0" />
        <span className="font-medium truncate">{organizationName}</span>
        <ArrowRight className="h-3 w-3 flex-shrink-0" />
        <span className={cn(
          "font-medium truncate",
          hasOverride && "text-orange-600 dark:text-orange-400"
        )}>
          {effectiveDestination}
        </span>
        {hasOverride && (
          <Badge variant="outline" className="h-4 px-1 text-[10px] border-orange-600 text-orange-600 dark:border-orange-400 dark:text-orange-400 flex-shrink-0">
            custom
          </Badge>
        )}
      </div>

      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-10 w-10 sm:h-6 sm:w-6 p-0 opacity-60 hover:opacity-100"
            title="Edit mirror destination"
            disabled={isUpdating || isLoading}
          >
            <Edit3 className="h-5 w-5 sm:h-3 sm:w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="space-y-4">
            <div>
              <h4 className="font-medium text-sm mb-1">Mirror Destination</h4>
              <p className="text-xs text-muted-foreground">
                Where this organization's repositories are mirrored on {destinationLabel}.
              </p>
            </div>

            <div className="space-y-3">
              {/* Visual Preview */}
              <div className="rounded-md bg-muted/50 p-3 space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Preview</div>
                <div className="flex items-center gap-2 text-sm">
                  <div className="flex items-center gap-1.5">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span>{organizationName}</span>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <div className="flex items-center gap-1.5">
                    <Building2 className="h-4 w-4 text-primary" />
                    <span className="font-medium text-primary">
                      {editValue.trim() || organizationName}
                    </span>
                  </div>
                </div>
              </div>

              {/* Input Field */}
              <div className="space-y-2">
                <Label htmlFor="destination" className="text-xs">
                  Destination Organization
                </Label>
                <Input
                  id="destination"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder={organizationName}
                  className="h-8"
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use the source organization name.
                </p>
              </div>

              {canMove && (
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <Checkbox
                    checked={moveMirrors}
                    onCheckedChange={(checked) => setMoveMirrors(checked === true)}
                    disabled={isLoading}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    Also move the mirrored repositories on {destinationLabel}
                    <span className="block text-muted-foreground">
                      {moveMirrors
                        ? `Transfers each mirrored repository of this organization, except ones with their own destination. You confirm the list first.`
                        : `Existing mirrors stay where they are and keep syncing. The new destination applies to repositories mirrored from now on.`}
                    </span>
                  </span>
                </label>
              )}

              {/* Quick Actions */}
              {hasOverride && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReset}
                  disabled={isLoading}
                  className="w-full h-8 text-xs"
                >
                  <RotateCcw className="h-3 w-3 mr-2" />
                  Reset to Default ({organizationName})
                </Button>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancel}
                disabled={isLoading}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isLoading || (editValue.trim() === (currentDestination || ""))}
              >
                {isLoading ? (
                  <>
                    <CheckCircle2 className="h-3 w-3 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* The confirmation lives outside the popover, which closes (and would
          unmount it) as soon as the dialog takes focus. */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !applying) setConfirmOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              Move {moveCount} repositor{moveCount === 1 ? "y" : "ies"} to {targetLabel}?
            </DialogTitle>
            <DialogDescription>
              {destinationLabel} transfers each repository with its history, issues and mirror settings, and
              creates {targetLabel} if it does not exist. Repositories with their own destination are not
              touched, and nothing is deleted.
            </DialogDescription>
          </DialogHeader>
          {plan && (
            <div className="min-w-0 space-y-4">
              <MoveList title="Will move" items={plan.plan.moves.map((entry) => `${entry.from} to ${entry.to}`)} />
              {plan.plan.skipped.length > 0 && (
                <MoveList
                  title="Left alone"
                  items={plan.plan.skipped.map((entry) => `${entry.fullName} (${entry.reason})`)}
                />
              )}
              <p className="text-[12px] text-muted-foreground">
                If the token cannot create repositories under {targetLabel}, {destinationLabel} asks an owner
                of {targetLabel} to accept each transfer. Those mirrors keep syncing where they are until
                then, and sync follows them once accepted.
              </p>
              {confirmError && (
                <p className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-500">
                  {confirmError}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={applying}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleConfirmMove()} disabled={applying}>
              {applying ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
              Move {moveCount}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
