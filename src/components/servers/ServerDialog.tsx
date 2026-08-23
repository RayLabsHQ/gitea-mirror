import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import type { Server, ServerType } from "@/lib/db/schema";
import { apiRequest, showErrorToast } from "@/lib/utils";
import { SERVER_TYPE_LABELS, type ServerApiResponse } from "./shared";

const SERVER_TYPES: ServerType[] = ["github", "gitlab", "gitea", "forgejo", "git"];

interface ServerDialogProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  /** When set, the dialog edits this server; otherwise it creates a new one. */
  server: Server | null;
  onSaved: () => void;
}

export function ServerDialog({
  isOpen,
  setIsOpen,
  server,
  onSaved,
}: ServerDialogProps) {
  const isEditing = server !== null;
  const [type, setType] = useState<ServerType>("github");
  const [name, setName] = useState<string>("");
  const [username, setUsername] = useState<string>("");
  const [token, setToken] = useState<string>("");
  const [url, setUrl] = useState<string>("");
  const [externalUrl, setExternalUrl] = useState<string>("");
  const [lfsEndpoint, setLfsEndpoint] = useState<string>("");
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      setType(server?.type ?? "github");
      setName(server?.name ?? "");
      setUsername(server?.username ?? "");
      setToken("");
      setUrl(server?.url ?? "");
      setExternalUrl(server?.externalUrl ?? "");
      setLfsEndpoint(server?.lfsEndpoint ?? "");
    }
  }, [isOpen, server]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      setIsSaving(true);

      const payload = {
        type,
        name: name.trim(),
        username: username.trim(),
        // Empty token on update means "keep the current token"
        token: isEditing && token === "" ? "" : token,
        url: url.trim(),
        externalUrl: externalUrl.trim() || undefined,
        lfsEndpoint: lfsEndpoint.trim() || undefined,
      };

      const response = await apiRequest<ServerApiResponse>(
        isEditing ? `/servers/${server.id}` : "/servers",
        {
          method: isEditing ? "PUT" : "POST",
          data: payload,
        }
      );

      if (response.success) {
        toast.success(response.message || (isEditing ? "Server updated" : "Server added"));
        setIsOpen(false);
        onSaved();
      } else {
        showErrorToast(response.message || "Failed to save server", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="w-[calc(100%-2rem)] sm:max-w-[480px] gap-0 gap-y-6 mx-4 sm:mx-0 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Server" : "Add Server"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the connection settings for this server."
              : "Connect a GitHub, GitLab, Gitea, Forgejo, or plain git server."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-y-4">
          <div>
            <Label htmlFor="server-type" className="block text-sm font-medium mb-1.5">
              Server Type
            </Label>
            <Select value={type} onValueChange={(val) => setType(val as ServerType)}>
              <SelectTrigger id="server-type" className="w-full">
                <SelectValue placeholder="Select server type" />
              </SelectTrigger>
              <SelectContent>
                {SERVER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {SERVER_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="server-name" className="block text-sm font-medium mb-1.5">
              Name
            </Label>
            <Input
              id="server-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., GitHub (work)"
              autoComplete="off"
              required
            />
          </div>

          <div>
            <Label htmlFor="server-username" className="block text-sm font-medium mb-1.5">
              Username
            </Label>
            <Input
              id="server-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Account name on that server"
              autoComplete="off"
              required
            />
          </div>

          <div>
            <Label htmlFor="server-token" className="block text-sm font-medium mb-1.5">
              Personal Access Token
            </Label>
            <Input
              id="server-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={isEditing ? "Leave empty to keep current token" : "Personal access token"}
              autoComplete="new-password"
              required={!isEditing}
            />
          </div>

          <div>
            <Label htmlFor="server-url" className="block text-sm font-medium mb-1.5">
              Server URL
            </Label>
            <Input
              id="server-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="e.g., https://github.com"
              autoComplete="off"
              required
            />
          </div>

          <div>
            <Label htmlFor="server-external-url" className="block text-sm font-medium mb-1.5">
              External URL <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="server-external-url"
              type="url"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              placeholder="Public-facing URL, if different"
              autoComplete="off"
            />
          </div>

          <div>
            <Label htmlFor="server-lfs-endpoint" className="block text-sm font-medium mb-1.5">
              LFS Endpoint <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="server-lfs-endpoint"
              type="url"
              value={lfsEndpoint}
              onChange={(e) => setLfsEndpoint(e.target.value)}
              placeholder="Dedicated Git LFS endpoint"
              autoComplete="off"
            />
          </div>

          <div className="flex justify-between pt-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => setIsOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : isEditing ? (
                "Save Changes"
              ) : (
                "Add Server"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
