import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface HostLockNoticeProps {
  /** One line shown next to the lock icon, e.g. "12 repositories imported from GitHub". */
  summary: string;
  /** Dialog title, e.g. "Change the source?". */
  title: string;
  /** What happens to existing repositories when the host changes. */
  consequences: string[];
  /** Label of the confirm button and of the inline button. */
  changeLabel: string;
  unlocked: boolean;
  onUnlock: () => void;
}

/**
 * Inline note for a locked source or destination, with the confirmation
 * dialog that unlocks the fields for a deliberate change.
 */
export function HostLockNotice({
  summary,
  title,
  consequences,
  changeLabel,
  unlocked,
  onUnlock,
}: HostLockNoticeProps) {
  const [open, setOpen] = useState(false);

  if (unlocked) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-muted-foreground">
        <LockOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span>Unlocked for this edit. Existing repositories stay tied to the previous host.</span>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span>{summary}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setOpen(true)}
        >
          {changeLabel}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{summary}.</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onUnlock();
              }}
            >
              {changeLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
