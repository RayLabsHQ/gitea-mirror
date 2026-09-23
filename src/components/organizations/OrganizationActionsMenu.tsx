import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Ban, MoreVertical, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import type { Organization } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

export interface OrganizationActionsMenuProps {
  org: Organization;
  disabled?: boolean;
  onSync?: ({ orgId }: { orgId: string }) => Promise<void>;
  onIgnore?: ({ orgId, ignore }: { orgId: string; ignore: boolean }) => Promise<void>;
  onDelete?: (orgId: string) => void;
  onEditMirrorOptions: (org: Organization) => void;
  triggerClassName?: string;
}

/**
 * The secondary actions of an organization, shared by the cards and the
 * list (#428). Hidden while the organization is being mirrored, like the
 * primary action.
 */
export function OrganizationActionsMenu({
  org,
  disabled = false,
  onSync,
  onIgnore,
  onDelete,
  onEditMirrorOptions,
  triggerClassName,
}: OrganizationActionsMenuProps) {
  if (org.status === "mirroring") return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          className={cn(triggerClassName)}
          title="More actions"
          aria-label={`More actions for ${org.name}`}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onSync && (org.status === "mirrored" || org.status === "failed") && (
          <>
            <DropdownMenuItem onClick={() => org.id && onSync({ orgId: org.id })}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Sync Organization
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => onEditMirrorOptions(org)}>
          <SlidersHorizontal className="h-4 w-4 mr-2" />
          Mirror Options
        </DropdownMenuItem>
        {org.status !== "ignored" && (
          <DropdownMenuItem
            onClick={() => org.id && onIgnore && onIgnore({ orgId: org.id, ignore: true })}
          >
            <Ban className="h-4 w-4 mr-2" />
            Ignore Organization
          </DropdownMenuItem>
        )}
        {onDelete && (
          <>
            {org.status !== "ignored" && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => org.id && onDelete(org.id)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete from Mirror
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
