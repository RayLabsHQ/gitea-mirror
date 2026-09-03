import { useState, useRef, useEffect } from "react";
import { Edit3, Check, X, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { destinationInfo } from "@/components/destination/DestinationIcon";
import { cn } from "@/lib/utils";
import type { Repository } from "@/lib/db/schema";

export interface DestinationUpdateOptions {
  /** Transfer the existing mirror on the destination as well (issue #400). */
  moveMirror: boolean;
}

interface InlineDestinationEditorProps {
  repository: Repository;
  giteaConfig: any;
  onUpdate: (
    repoId: string,
    newDestination: string | null,
    options: DestinationUpdateOptions
  ) => Promise<void>;
  isUpdating?: boolean;
  className?: string;
}

// Statuses in which the mirror is either absent or being worked on, so the
// label can change but nothing should be transferred right now.
const CANNOT_MOVE_STATUSES = new Set(["imported", "deleted", "deleting", "mirroring", "syncing"]);

export function InlineDestinationEditor({
  repository,
  giteaConfig,
  onUpdate,
  isUpdating = false,
  className,
}: InlineDestinationEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingChange, setPendingChange] = useState<{ destination: string | null; owner: string } | null>(null);
  const [moveMirror, setMoveMirror] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Determine the default destination based on repository properties and config
  const getDefaultDestination = () => {
    // Starred repos can use either dedicated org or preserved source owner
    if (repository.isStarred) {
      const starredReposMode = giteaConfig?.starredReposMode || "dedicated-org";
      if (starredReposMode === "preserve-owner") {
        return repository.organization || repository.owner;
      }
      if (giteaConfig?.starredReposOrg) {
        return giteaConfig.starredReposOrg;
      }
      return "starred";
    }
    
    // Check mirror strategy
    const strategy = giteaConfig?.mirrorStrategy || 'preserve';
    
    if (strategy === 'single-org' && giteaConfig?.organization) {
      // All repos go to a single organization
      return giteaConfig.organization;
    } else if (strategy === 'flat-user') {
      // All repos go under the user account
      return giteaConfig?.username || repository.owner;
    } else {
      // 'preserve' strategy or default
      // For organization repos, use the organization name
      if (repository.organization) {
        return repository.organization;
      }
      // For personal repos, check if personalReposOrg is configured (but not in preserve mode)
      if (!repository.organization && giteaConfig?.personalReposOrg && strategy !== 'preserve') {
        return giteaConfig.personalReposOrg;
      }
      // Default to the gitea username or owner
      return giteaConfig?.username || repository.owner;
    }
  };

  const defaultDestination = getDefaultDestination();
  const currentDestination = repository.destinationOrg || defaultDestination;
  const hasOverride = repository.destinationOrg && repository.destinationOrg !== defaultDestination;
  const isStarredRepo = repository.isStarred;

  const destination = destinationInfo(giteaConfig);
  const mirrorLocation = (repository.mirroredLocation ?? "").trim();
  const mirrorOwner = mirrorLocation.includes("/") ? mirrorLocation.slice(0, mirrorLocation.indexOf("/")) : "";
  // A mirror that exists on a Gitea or Forgejo destination can move along with the label.
  const canMove = mirrorOwner !== "" && !destination.isPushTarget && !CANNOT_MOVE_STATUSES.has(repository.status);
  // The label names one owner while the mirror sits under another: what issue #400 ran into.
  const labelDisagrees =
    Boolean(repository.destinationOrg) &&
    mirrorOwner !== "" &&
    mirrorOwner.toLowerCase() !== (repository.destinationOrg ?? "").toLowerCase();

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEdit = () => {
    if (isStarredRepo) return; // Don't allow editing starred repos
    setEditValue(currentDestination);
    setIsEditing(true);
  };

  const handleSave = async () => {
    const trimmedValue = editValue.trim();
    const newDestination = trimmedValue === defaultDestination ? null : trimmedValue;

    if (trimmedValue === currentDestination) {
      setIsEditing(false);
      return;
    }

    if (canMove) {
      // The mirror exists: ask whether to move it before writing anything.
      setPendingChange({ destination: newDestination, owner: trimmedValue || defaultDestination });
      setMoveMirror(true);
      setConfirmError(null);
      setIsEditing(false);
      return;
    }

    setIsLoading(true);
    try {
      await onUpdate(repository.id!, newDestination, { moveMirror: false });
      setIsEditing(false);
    } catch (error) {
      // Revert on error
      setEditValue(currentDestination);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!pendingChange) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await onUpdate(repository.id!, pendingChange.destination, { moveMirror });
      setPendingChange(null);
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : "Failed to update the destination");
    } finally {
      setConfirming(false);
    }
  };

  const handleCancel = () => {
    setEditValue(currentDestination);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  const targetOwner = pendingChange?.owner ?? "";
  const confirmDialog = (
    <Dialog
      open={pendingChange !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) setPendingChange(null);
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Change the destination of {repository.name}</DialogTitle>
          <DialogDescription>
            The mirror is at <span className="font-mono">{mirrorLocation}</span> on {destination.label}.
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm">
          <Checkbox
            checked={moveMirror}
            onCheckedChange={(checked) => setMoveMirror(checked === true)}
            disabled={confirming}
            className="mt-0.5"
          />
          <span className="min-w-0">
            Move the mirror to {targetOwner}
            <span className="block text-[12px] text-muted-foreground">
              {moveMirror
                ? `${destination.label} transfers the repository with its history, issues and mirror settings, and creates ${targetOwner} if it does not exist. If the token cannot create repositories under ${targetOwner}, an owner of ${targetOwner} has to accept the transfer, and sync follows once they do.`
                : `Only the label changes. The mirror stays at ${mirrorLocation} and keeps syncing there. The new destination is used only if the mirror is created again.`}
            </span>
          </span>
        </label>
        {confirmError && (
          <p className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-500">
            {confirmError}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setPendingChange(null)} disabled={confirming}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleConfirm()} disabled={confirming}>
            {confirming ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            {moveMirror ? "Move and save" : "Save the label only"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (isEditing) {
    return (
      <>
        <div className={cn("flex items-center gap-1", className)}>
          <Input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleCancel}
            className="h-6 text-sm px-2 py-0 w-24"
            disabled={isLoading}
          />
          {/* preventDefault on mousedown keeps the input focused, so its
              blur (which cancels the edit) does not fire before the click. */}
          <Button
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleSave}
            disabled={isLoading}
            title="Save"
          >
            <Check className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleCancel}
            disabled={isLoading}
            title="Cancel"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
        {confirmDialog}
      </>
    );
  }

  return (
    <>
      <div className={cn("flex flex-col gap-0.5", className)}>
        {/* Show GitHub org if exists */}
        {repository.organization && (
          <span className="text-xs text-muted-foreground">
            {repository.organization}
          </span>
        )}
        
        {/* Show Gitea destination */}
        <div className="flex items-center gap-1 group">
          <span className="text-sm">
            {currentDestination || "-"}
          </span>
          {hasOverride && (
            <Badge variant="outline" className="h-4 px-1 text-[10px] ml-1">
              custom
            </Badge>
          )}
          {labelDisagrees && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[10px] ml-1 border-amber-500/60 text-amber-600 dark:text-amber-400"
              title={`The mirror is at ${mirrorLocation}, not under ${repository.destinationOrg}. Edit the destination and tick Move to transfer it, or run Reconcile with destination.`}
            >
              at {mirrorOwner}
            </Badge>
          )}
          {isStarredRepo && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px] ml-1">
              starred
            </Badge>
          )}
          {!isStarredRepo && (
            <Button
              size="sm"
              variant="ghost"
              className="h-4 w-4 p-0 opacity-0 group-hover:opacity-60 hover:opacity-100 ml-1"
              onClick={handleStartEdit}
              disabled={isUpdating || isLoading}
              title="Edit destination"
            >
              <Edit3 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      {confirmDialog}
    </>
  );
}
