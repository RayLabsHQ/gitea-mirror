import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { selectTriggerClassName } from "@/components/ui/select";
import { cn, getStatusColor } from "@/lib/utils";
import {
  REPOSITORY_STATUSES,
  formatStatusFilter,
  parseStatusFilter,
  statusFilterSummary,
  statusLabel,
} from "@/lib/repository-status-filter";

/**
 * Status filter for the Repositories page (#580): any number of statuses,
 * picked with checkboxes. Nothing picked shows every repository. The list
 * stays open while boxes are toggled, so "everything except Imported" is
 * Select all, then one click.
 */
export function StatusFilter({
  value,
  onChange,
  counts,
  className,
}: {
  /** Comma separated statuses, empty for all. */
  value: string;
  onChange: (value: string) => void;
  /** Repositories per status, shown next to each. */
  counts?: Record<string, number>;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = parseStatusFilter(value);
  const selectedSet = new Set<string>(selected);
  const showsEverything = selected.length === 0 || selected.length === REPOSITORY_STATUSES.length;

  const toggle = (status: string, checked: boolean) => {
    const next = new Set(selectedSet);
    if (checked) next.add(status);
    else next.delete(status);
    onChange(formatStatusFilter(next));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Status: ${statusFilterSummary(value)}`}
          aria-expanded={open}
          title={showsEverything ? undefined : selected.map(statusLabel).join(", ")}
          className={cn(selectTriggerClassName, "h-10 w-full lg:w-[170px]", className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            {/* Dots only while they show the whole selection; past three the text says enough. */}
            {!showsEverything && selected.length <= 3 && (
              <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                {selected.map((status) => (
                  <span key={status} className={cn("h-2 w-2 rounded-full", getStatusColor(status))} />
                ))}
              </span>
            )}
            <span className={cn("truncate", showsEverything && "text-muted-foreground")}>
              {statusFilterSummary(value)}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[max(15rem,var(--radix-popover-trigger-width))] p-0">
        <div
          role="group"
          aria-label="Statuses"
          className="max-h-[calc(var(--radix-popover-content-available-height)-2.75rem)] overflow-y-auto p-1"
        >
          {REPOSITORY_STATUSES.map((status) => {
            const id = `status-filter-${status}`;
            const count = counts?.[status] ?? 0;
            return (
              <label
                key={status}
                htmlFor={id}
                className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <Checkbox
                  id={id}
                  checked={selectedSet.has(status)}
                  onCheckedChange={(checked) => toggle(status, checked === true)}
                />
                <span className={cn("h-2 w-2 shrink-0 rounded-full", getStatusColor(status))} />
                <span className="flex-1 truncate">{statusLabel(status)}</span>
                {counts && (
                  <span className={cn("text-xs tabular-nums", count === 0 ? "text-muted-foreground/50" : "text-muted-foreground")}>
                    {count}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        <div className="flex items-center justify-between border-t p-1">
          <button
            type="button"
            className="rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => onChange(formatStatusFilter(REPOSITORY_STATUSES))}
            disabled={selected.length === REPOSITORY_STATUSES.length}
          >
            Select all
          </button>
          <button
            type="button"
            className="rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => onChange("")}
            disabled={selected.length === 0}
          >
            Clear
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
