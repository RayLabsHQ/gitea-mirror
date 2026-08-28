import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { Server } from "@/lib/db/schema";
import { apiRequest, formatDate, showErrorToast } from "@/lib/utils";
import { useNavigation } from "@/components/layout/MainLayout";
import { ServerCard } from "./ServerCard";
import { MatrixView } from "./MatrixView";
import {
  SERVER_TYPE_LABELS,
  type MatrixApiResponse,
  type MirrorPairWithServers,
  type ServersApiResponse,
} from "./shared";

export function ServersView() {
  const [servers, setServers] = useState<Server[]>([]);
  const [pairs, setPairs] = useState<MirrorPairWithServers[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isServerCardOpen, setIsServerCardOpen] = useState<boolean>(false);
  const [editingServer, setEditingServer] = useState<Server | null>(null);
  const [serverToDelete, setServerToDelete] = useState<Server | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [testingServerIds, setTestingServerIds] = useState<Set<string>>(new Set());
  const { navigationKey } = useNavigation();
  const defaultTab =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("tab") === "matrix"
      ? "matrix"
      : "servers";

  const handleTabChange = (value: string) => {
    const url = new URL(window.location.href);
    if (value === "matrix") {
      url.searchParams.set("tab", "matrix");
    } else {
      url.searchParams.delete("tab");
    }
    window.history.replaceState({}, "", url);
  };

  const fetchServers = useCallback(async () => {
    try {
      setIsLoading(true);

      const response = await apiRequest<ServersApiResponse>("/servers", {
        method: "GET",
      });

      setServers(response.servers ?? []);
      return true;
    } catch (error) {
      showErrorToast(error, toast);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchPairs = useCallback(async () => {
    try {
      const response = await apiRequest<MatrixApiResponse>("/matrix", {
        method: "GET",
      });

      setPairs(response.pairs ?? []);
    } catch (error) {
      showErrorToast(error, toast);
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    fetchServers();
    fetchPairs();
  }, [fetchServers, fetchPairs, navigationKey]);

  const handleRefresh = async () => {
    const success = await fetchServers();
    await fetchPairs();
    if (success) {
      toast.success("Servers refreshed successfully.");
    }
  };

  const handleAddServer = () => {
    setEditingServer(null);
    setIsServerCardOpen(true);
  };

  const handleEditServer = (server: Server) => {
    setEditingServer(server);
    setIsServerCardOpen(true);
  };

  const handleTestConnection = async (server: Server) => {
    try {
      setTestingServerIds((prev) => new Set(prev).add(server.id));

      const response = await apiRequest<{ success: boolean; message: string }>(
        `/servers/${server.id}/test`,
        { method: "POST" }
      );

      if (response.success) {
        toast.success(response.message || `Connected to ${server.name}`);
      } else {
        toast.error(response.message || `Connection to ${server.name} failed`);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setTestingServerIds((prev) => {
        const next = new Set(prev);
        next.delete(server.id);
        return next;
      });
    }
  };

  const handleDeleteServer = async () => {
    if (!serverToDelete) {
      return;
    }

    setIsDeleting(true);
    try {
      const response = await apiRequest<{ success: boolean; message?: string }>(
        `/servers/${serverToDelete.id}`,
        { method: "DELETE" }
      );

      if (response.success) {
        toast.success(response.message || `Removed ${serverToDelete.name}.`);
        await fetchServers();
        await fetchPairs();
      } else {
        showErrorToast(response.message || "Failed to delete server", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsDeleting(false);
      setServerToDelete(null);
    }
  };

  return (
    <div className="flex flex-col gap-y-4 sm:gap-y-6">
      <Tabs defaultValue={defaultTab} onValueChange={handleTabChange} className="space-y-4">
        <TabsList className="grid h-auto w-full grid-cols-2 sm:max-w-[400px]">
          <TabsTrigger value="servers">Servers</TabsTrigger>
          <TabsTrigger value="matrix">Flow / Matrix</TabsTrigger>
        </TabsList>

        <TabsContent value="servers" className="space-y-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={handleRefresh}
              title="Refresh servers"
              className="h-10 w-10"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="default"
              onClick={handleAddServer}
              disabled={isServerCardOpen && editingServer === null}
              className="h-10 px-4 ml-auto"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Server
            </Button>
          </div>

          {isServerCardOpen && (
            <ServerCard
              server={editingServer}
              onCancel={() => {
                setIsServerCardOpen(false);
                setEditingServer(null);
              }}
              onSaved={async () => {
                setIsServerCardOpen(false);
                setEditingServer(null);
                await fetchServers();
              }}
            />
          )}

          {isLoading ? (
            <div className="border rounded-md">
              <div className="h-[45px] flex items-center border-b bg-muted/50 px-3 gap-4">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-24" />
              </div>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-[65px] flex items-center border-b px-3 gap-4">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-5 w-56" />
                </div>
              ))}
            </div>
          ) : servers.length === 0 ? (
            isServerCardOpen ? null : (
              <div className="border rounded-md text-center py-12">
                <p className="text-muted-foreground">
                  No servers configured yet. Add a server to start building your mirror matrix.
                </p>
              </div>
            )
          ) : (
            <div className="border rounded-md overflow-x-auto">
              <div className="min-w-[760px]">
                <div className="h-[45px] flex items-center border-b bg-muted/50">
                  <div className="h-full p-3 text-sm font-medium flex-[1.2]">Name</div>
                  <div className="h-full p-3 text-sm font-medium flex-[0.8]">Type</div>
                  <div className="h-full p-3 text-sm font-medium flex-[1.6]">URL</div>
                  <div className="h-full p-3 text-sm font-medium flex-[1]">Username</div>
                  <div className="h-full p-3 text-sm font-medium flex-[1]">Created</div>
                  <div className="h-full p-3 text-sm font-medium flex-[1.4]">Actions</div>
                </div>

                {servers.map((server) => (
                  <div
                    key={server.id}
                    className="h-[65px] flex items-center border-b last:border-b-0 bg-transparent hover:bg-muted/50"
                  >
                    <div className="h-full p-3 flex items-center flex-[1.2] text-sm font-medium">
                      {server.name}
                    </div>
                    <div className="h-full p-3 flex items-center flex-[0.8]">
                      <Badge variant="secondary">
                        {SERVER_TYPE_LABELS[server.type] ?? server.type}
                      </Badge>
                    </div>
                    <div className="h-full p-3 flex items-center flex-[1.6] text-sm text-muted-foreground truncate">
                      {server.url}
                    </div>
                    <div className="h-full p-3 flex items-center flex-[1] text-sm">
                      {server.username}
                    </div>
                    <div className="h-full p-3 flex items-center flex-[1] text-sm text-muted-foreground">
                      {formatDate(server.createdAt)}
                    </div>
                    <div className="h-full p-3 flex items-center flex-[1.4] gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleTestConnection(server)}
                        disabled={testingServerIds.has(server.id)}
                        title="Test connection"
                      >
                        {testingServerIds.has(server.id) ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <PlugZap className="h-4 w-4 mr-1" />
                            Test
                          </>
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => handleEditServer(server)}
                        title="Edit server"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setServerToDelete(server)}
                        title="Delete server"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="matrix">
          <MatrixView
            servers={servers}
            pairs={pairs}
            isLoading={isLoading}
            onRefresh={fetchPairs}
          />
        </TabsContent>
      </Tabs>

      <Dialog
        open={serverToDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setServerToDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete server?</DialogTitle>
            <DialogDescription>
              {serverToDelete?.name ?? "This server"} will be removed from Gitea
              Mirror. Mirror pairs that use this server may stop working.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setServerToDelete(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteServer}
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
