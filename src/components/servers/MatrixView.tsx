import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoaderCircle, Plus, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Server, ServerType } from "@/lib/db/schema";
import { withBase } from "@/lib/base-path";
import { apiRequest, showErrorToast } from "@/lib/utils";
import { PairSettingsDialog } from "./PairSettingsDialog";
import {
  SERVER_TYPE_LABELS,
  usernamesForType,
  type MatrixPairApiResponse,
  type MirrorPairWithServers,
} from "./shared";

interface MatrixViewProps {
  servers: Server[];
  pairs: MirrorPairWithServers[];
  isLoading: boolean;
  onRefresh: () => void;
}

export function MatrixView({ servers, pairs, isLoading, onRefresh }: MatrixViewProps) {
  const [settingsPair, setSettingsPair] = useState<MirrorPairWithServers | null>(null);
  const [pairToDelete, setPairToDelete] = useState<MirrorPairWithServers | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [updatingPairIds, setUpdatingPairIds] = useState<Set<string>>(new Set());

  const updatePair = async (
    pairId: string,
    data: Record<string, unknown>,
    successMessage: string
  ) => {
    try {
      setUpdatingPairIds((prev) => new Set(prev).add(pairId));

      const response = await apiRequest<MatrixPairApiResponse>(
        `/matrix/${pairId}`,
        { method: "PUT", data }
      );

      if (response.success) {
        toast.success(response.message || successMessage);
        onRefresh();
      } else {
        showErrorToast(response.message || "Failed to update mirror pair", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setUpdatingPairIds((prev) => {
        const next = new Set(prev);
        next.delete(pairId);
        return next;
      });
    }
  };

  const handleToggleEnabled = (pair: MirrorPairWithServers, enabled: boolean) => {
    updatePair(pair.id, { enabled }, enabled ? "Mirror pair enabled" : "Mirror pair paused");
  };

  const handleChangeUsername = (pair: MirrorPairWithServers, username: string) => {
    updatePair(pair.id, { username }, "Mirror pair username updated");
  };

  const handleDeletePair = async () => {
    if (!pairToDelete) {
      return;
    }

    setIsDeleting(true);
    try {
      const response = await apiRequest<{ success: boolean; message?: string }>(
        `/matrix/${pairToDelete.id}`,
        { method: "DELETE" }
      );

      if (response.success) {
        toast.success(response.message || "Mirror pair deleted");
        onRefresh();
      } else {
        showErrorToast(response.message || "Failed to delete mirror pair", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsDeleting(false);
      setPairToDelete(null);
    }
  };

  if (isLoading) {
    return (
      <div className="border rounded-md">
        <div className="h-[45px] flex items-center border-b bg-muted/50 px-3 gap-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-[65px] flex items-center border-b px-3 gap-4">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-48" />
          </div>
        ))}
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="border rounded-md text-center py-12">
        <p className="text-muted-foreground">
          No servers configured yet. Add servers in the Servers tab first, then
          come back to define mirror pairs.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="default"
          onClick={() => {
            window.location.href = withBase("/servers/pairs/new");
          }}
          className="h-10 px-4 ml-auto"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Pair
        </Button>
      </div>

      {pairs.length === 0 ? (
        <div className="border rounded-md text-center py-12">
          <p className="text-muted-foreground">
            No mirror pairs defined yet. Add a pair to start syncing between
            your servers.
          </p>
        </div>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <div className="min-w-[1080px]">
            <div className="h-[45px] flex items-center border-b bg-muted/50">
              <div className="h-full p-3 text-sm font-medium flex-[0.7]">Source</div>
              <div className="h-full p-3 text-sm font-medium flex-[0.7]">Target</div>
              <div className="h-full p-3 text-sm font-medium flex-[1.4]">Source Instance</div>
              <div className="h-full p-3 text-sm font-medium flex-[1.4]">Target Instance</div>
              <div className="h-full p-3 text-sm font-medium flex-[1]">Mirror Type</div>
              <div className="h-full p-3 text-sm font-medium flex-[1]">Username</div>
              <div className="h-full p-3 text-sm font-medium flex-[0.6]">Enabled</div>
              <div className="h-full p-3 text-sm font-medium flex-[1]">Actions</div>
            </div>

            {pairs.map((pair) => {
              const isUpdating = updatingPairIds.has(pair.id);
              const sourceType = pair.sourceServer?.type ?? "git";
              const usernameOptions = Array.from(
                new Set([pair.username, ...usernamesForType(servers, sourceType)])
              );

              return (
                <div
                  key={pair.id}
                  className="h-[65px] flex items-center border-b last:border-b-0 bg-transparent hover:bg-muted/50"
                >
                  <div className="h-full p-3 flex items-center flex-[0.7]">
                    <Badge variant="secondary">
                      {SERVER_TYPE_LABELS[sourceType] ?? sourceType}
                    </Badge>
                  </div>
                  <div className="h-full p-3 flex items-center flex-[0.7]">
                    <Badge variant="secondary">
                      {SERVER_TYPE_LABELS[pair.targetServer?.type ?? "git"] ??
                        pair.targetServer?.type}
                    </Badge>
                  </div>
                  <div className="h-full p-3 flex items-center flex-[1.4] text-sm text-muted-foreground truncate">
                    {pair.sourceServer?.url}
                  </div>
                  <div className="h-full p-3 flex items-center flex-[1.4] text-sm text-muted-foreground truncate">
                    {pair.targetServer?.url}
                  </div>
                  <div className="h-full p-3 flex items-center flex-[1] text-sm">
                    {pair.mirrorType === "two-way"
                      ? "Two Way Mirror"
                      : "Source to Target"}
                  </div>
                  <div className="h-full p-3 flex items-center flex-[1]">
                    <Select
                      value={pair.username}
                      onValueChange={(val) => handleChangeUsername(pair, val)}
                      disabled={isUpdating}
                    >
                      <SelectTrigger className="w-full h-8">
                        <SelectValue placeholder="Username" />
                      </SelectTrigger>
                      <SelectContent>
                        {usernameOptions.map((username) => (
                          <SelectItem key={username} value={username}>
                            {username}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="h-full p-3 flex items-center flex-[0.6]">
                    <Switch
                      checked={pair.enabled}
                      onCheckedChange={(checked) => handleToggleEnabled(pair, checked)}
                      disabled={isUpdating}
                    />
                  </div>
                  <div className="h-full p-3 flex items-center flex-[1] gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setSettingsPair(pair)}
                      title="Pair settings"
                    >
                      <Settings2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPairToDelete(pair)}
                      title="Delete pair"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <PairSettingsDialog
        pair={settingsPair}
        servers={servers}
        isOpen={settingsPair !== null}
        setIsOpen={(open) => {
          if (!open) {
            setSettingsPair(null);
          }
        }}
        onSaved={onRefresh}
      />

      <Dialog
        open={pairToDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPairToDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete mirror pair?</DialogTitle>
            <DialogDescription>
              Mirroring between {pairToDelete?.sourceServer?.name ?? "the source"}{" "}
              and {pairToDelete?.targetServer?.name ?? "the target"} will stop.
              Already mirrored repositories are not removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPairToDelete(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeletePair}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <span className="flex items-center gap-2">
                  <Trash2 className="h-4 w-4" />
                  Delete
                </span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
