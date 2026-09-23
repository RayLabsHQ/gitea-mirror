import { useState } from "react";
import { toast } from "sonner";
import { Layers } from "lucide-react";
import type { SourceApiRecord } from "@/types/config";
import { SOURCE_PROVIDER_ICONS } from "@/lib/source-providers/icons";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Radix reserves the empty string as a Select value, so unpinned
// organizations use this sentinel instead.
const EVERY_SOURCE_VALUE = "every-source";

export interface OrganizationSourceEditorProps {
  sources: SourceApiRecord[];
  value?: string | null;
  disabled?: boolean;
  onUpdateSource: (sourceId: string | null) => Promise<void>;
  /** Drop the "Source" label; the list view puts it in the column header. */
  compact?: boolean;
  className?: string;
}

/**
 * Pin an organization to one connected source, or let it follow every
 * source. Shown by the cards and the list only when more than one source
 * is connected.
 */
export function OrganizationSourceEditor({
  sources,
  value,
  disabled = false,
  onUpdateSource,
  compact = false,
  className,
}: OrganizationSourceEditorProps) {
  const [isUpdating, setIsUpdating] = useState(false);

  const handleValueChange = async (next: string) => {
    setIsUpdating(true);
    try {
      await onUpdateSource(next === EVERY_SOURCE_VALUE ? null : next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update source");
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className={cn("flex items-center gap-2 w-full", className)}>
      {!compact && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
          <Layers className="h-3 w-3" />
          Source
        </span>
      )}
      <Select
        value={value ?? EVERY_SOURCE_VALUE}
        onValueChange={(next) => void handleValueChange(next)}
        disabled={disabled || isUpdating}
      >
        <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" aria-label="Source">
          <SelectValue placeholder="Source" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={EVERY_SOURCE_VALUE}>Every source</SelectItem>
          {sources.map((source) => {
            const SourceIcon = SOURCE_PROVIDER_ICONS[source.provider];
            return (
              <SelectItem key={source.id} value={source.id}>
                <span className="flex items-center gap-2">
                  <SourceIcon className="h-3.5 w-3.5" />
                  {source.name}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
