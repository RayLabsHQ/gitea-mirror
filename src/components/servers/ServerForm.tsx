import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TokenCreationGuide } from "@/components/config/TokenCreationGuide";
import { LoaderCircle, PlugZap } from "lucide-react";
import { toast } from "sonner";
import type { Server, ServerType } from "@/lib/db/schema";
import { apiRequest, showErrorToast } from "@/lib/utils";
import { SERVER_TYPE_LABELS, type ServerApiResponse } from "./shared";

const SERVER_TYPES: ServerType[] = ["github", "gitlab", "gitea", "forgejo", "git"];

interface TokenGuide {
  settingsUrl?: string;
  settingsTitle?: string;
  steps: string[];
  scopes: string[];
}

function appendSettingsPath(serverUrl: string, path: string): string | undefined {
  try {
    const baseUrl = new URL(serverUrl.trim());
    return `${baseUrl.toString().replace(/\/$/, "")}${path}`;
  } catch {
    return undefined;
  }
}

function getTokenGuide(type: ServerType, serverUrl: string): TokenGuide {
  switch (type) {
    case "github":
      return {
        settingsUrl: "https://github.com/settings/tokens",
        settingsTitle: "Open GitHub token settings",
        steps: [
          "GitHub → Settings → Developer settings",
          "Personal access tokens → Generate new token (classic)",
          "Select the scopes below and paste the token here",
        ],
        scopes: ["repo", "admin:org"],
      };
    case "gitlab":
      return {
        settingsUrl: appendSettingsPath(
          serverUrl || "https://gitlab.com",
          "/-/user_settings/personal_access_tokens"
        ),
        settingsTitle: "Open GitLab personal access tokens",
        steps: [
          "GitLab → Edit profile → Access → Personal access tokens",
          "Generate a legacy token for this connection",
          "Select the scopes below and paste the token here",
        ],
        scopes: ["api", "write_repository"],
      };
    case "gitea":
      return {
        settingsUrl: appendSettingsPath(serverUrl, "/user/settings/applications"),
        settingsTitle: "Open Gitea application settings",
        steps: [
          "Gitea → Settings → Applications",
          "Generate a new token and open Select permissions",
          "Grant the permissions below and paste the token here",
        ],
        scopes: ["write:repository", "write:organization", "write:issue", "read:user"],
      };
    case "forgejo":
      return {
        settingsUrl: appendSettingsPath(serverUrl, "/user/settings/applications"),
        settingsTitle: "Open Forgejo application settings",
        steps: [
          "Forgejo → Settings → Applications",
          "Create a token with access to the repositories and organizations you will mirror",
          "Grant the permissions below and paste the token here",
        ],
        scopes: ["write:repository", "write:organization", "write:issue", "read:user"],
      };
    case "git":
      return {
        steps: [
          "Open the access-token or app-password settings for your Git host",
          "Create a credential with read and write repository access",
          "Paste it here for authenticated HTTPS operations",
        ],
        scopes: ["read/write repository"],
      };
  }
}

interface ServerFormProps {
  /** When set, the form edits this server; otherwise it creates a new one. */
  server?: Server | null;
  onSaved: () => void | Promise<unknown>;
  onCancel: () => void;
  showCancel?: boolean;
}

export function ServerForm({
  server = null,
  onSaved,
  onCancel,
  showCancel = true,
}: ServerFormProps) {
  const isEditing = server !== null;
  const [type, setType] = useState<ServerType>(server?.type ?? "github");
  const [name, setName] = useState<string>(server?.name ?? "");
  const [username, setUsername] = useState<string>(server?.username ?? "");
  const [token, setToken] = useState<string>("");
  const [url, setUrl] = useState<string>(server?.url ?? "");
  const [externalUrl, setExternalUrl] = useState<string>(server?.externalUrl ?? "");
  const [lfsEndpoint, setLfsEndpoint] = useState<string>(server?.lfsEndpoint ?? "");
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);

  useEffect(() => {
    setType(server?.type ?? "github");
    setName(server?.name ?? "");
    setUsername(server?.username ?? "");
    setToken("");
    setUrl(server?.url ?? "");
    setExternalUrl(server?.externalUrl ?? "");
    setLfsEndpoint(server?.lfsEndpoint ?? "");
  }, [server]);

  const tokenGuide = getTokenGuide(type, url);
  const connectionToken = token || server?.token || "";
  const canTest = Boolean(url.trim()) && (type === "git" || Boolean(connectionToken.trim()));

  const handleTestConnection = async () => {
    try {
      setIsTesting(true);

      const response = await apiRequest<{ success: boolean; message: string }>(
        "/servers/test",
        {
          method: "POST",
          data: {
            type,
            url: url.trim(),
            username: username.trim(),
            token: connectionToken,
          },
        }
      );

      if (response.success) {
        toast.success(response.message || "Connection successful");
      } else {
        toast.error(response.message || "Connection failed");
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsTesting(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    try {
      setIsSaving(true);

      const payload = {
        type,
        name: name.trim(),
        username: username.trim(),
        // Empty token on update means "keep the current token".
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
        await onSaved();
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-y-4">
      <div className="space-y-1.5">
        <Label
          htmlFor={isEditing ? "edit-server-type" : "add-server-type"}
          className="text-xs font-medium text-muted-foreground"
        >
          Server Type
        </Label>
        <Select value={type} onValueChange={(value) => setType(value as ServerType)}>
          <SelectTrigger
            id={isEditing ? "edit-server-type" : "add-server-type"}
            className="w-full"
          >
            <SelectValue placeholder="Select server type" />
          </SelectTrigger>
          <SelectContent>
            {SERVER_TYPES.map((serverType) => (
              <SelectItem key={serverType} value={serverType}>
                {SERVER_TYPE_LABELS[serverType]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor={isEditing ? "edit-server-name" : "add-server-name"}
          className="text-xs font-medium text-muted-foreground"
        >
          Name
        </Label>
        <Input
          id={isEditing ? "edit-server-name" : "add-server-name"}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g., GitHub (work)"
          autoComplete="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor={isEditing ? "edit-server-username" : "add-server-username"}
          className="text-xs font-medium text-muted-foreground"
        >
          Username
        </Label>
        <Input
          id={isEditing ? "edit-server-username" : "add-server-username"}
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Account name on that server"
          autoComplete="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor={isEditing ? "edit-server-token" : "add-server-token"}
          className="text-xs font-medium text-muted-foreground"
        >
          Personal Access Token
        </Label>
        <Input
          id={isEditing ? "edit-server-token" : "add-server-token"}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={isEditing ? "Leave empty to keep current token" : "Personal access token"}
          autoComplete="new-password"
          required={!isEditing}
        />
      </div>

      <TokenCreationGuide
        settingsUrl={tokenGuide.settingsUrl}
        settingsTitle={tokenGuide.settingsTitle}
        steps={tokenGuide.steps}
        scopes={tokenGuide.scopes}
      />

      <div className="space-y-1.5">
        <Label
          htmlFor={isEditing ? "edit-server-url" : "add-server-url"}
          className="text-xs font-medium text-muted-foreground"
        >
          Server URL
        </Label>
        <Input
          id={isEditing ? "edit-server-url" : "add-server-url"}
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="e.g., https://github.com"
          autoComplete="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor={isEditing ? "edit-server-external-url" : "add-server-external-url"}
          className="text-xs font-medium text-muted-foreground"
        >
          External URL (optional)
        </Label>
        <Input
          id={isEditing ? "edit-server-external-url" : "add-server-external-url"}
          type="url"
          value={externalUrl}
          onChange={(event) => setExternalUrl(event.target.value)}
          placeholder="Public-facing URL, if different"
          autoComplete="off"
        />
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor={isEditing ? "edit-server-lfs-endpoint" : "add-server-lfs-endpoint"}
          className="text-xs font-medium text-muted-foreground"
        >
          LFS Endpoint (optional)
        </Label>
        <Input
          id={isEditing ? "edit-server-lfs-endpoint" : "add-server-lfs-endpoint"}
          type="url"
          value={lfsEndpoint}
          onChange={(event) => setLfsEndpoint(event.target.value)}
          placeholder="Dedicated Git LFS endpoint"
          autoComplete="off"
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        {showCancel && (
          <Button type="button" variant="outline" disabled={isSaving} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={isSaving || isTesting || !canTest}
          onClick={handleTestConnection}
        >
          {isTesting ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <PlugZap className="mr-1.5 h-3.5 w-3.5" />
              Test
            </>
          )}
        </Button>
        <Button type="submit" disabled={isSaving || isTesting}>
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
  );
}
