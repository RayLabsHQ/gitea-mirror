import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Activity,
  ExternalLink,
  KeyRound,
  Layers,
  Lock,
  Pencil,
  Plus,
  PlugZap,
  Trash2,
} from "lucide-react";
import { SiGitea, SiGithub, SiGitlab } from "react-icons/si";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { githubApi } from "@/lib/api";
import { withBase } from "@/lib/base-path";
import type { SourceApiRecord, SourceProvider } from "@/types/config";
import {
  SOURCE_PROVIDER_DEFAULT_URLS,
  SOURCE_PROVIDER_LABELS,
  isBetaSourceProvider,
} from "@/lib/source-providers/kinds";
import { invalidateConfigCache } from "@/hooks/useConfigStatus";
import { HostLockNotice } from "./HostLockNotice";
import { CardDivider, CardSection, SettingsCard } from "./settings-ui";

const SOURCES_API_PATH = withBase("/api/sources");

type SourceProviderMeta = {
  value: SourceProvider;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  usernamePlaceholder: string;
  tokenPlaceholder: string;
  tokenHint: string;
  /** Appended to the instance URL to reach the token settings page. */
  tokenSettingsPath: string;
  tokenSteps: string[];
  scopes: string[];
  /** Short pill shown next to the option, e.g. BETA. */
  badge?: string;
};

const sourceProviders: SourceProviderMeta[] = [
  {
    value: "github",
    label: SOURCE_PROVIDER_LABELS.github,
    icon: SiGithub,
    usernamePlaceholder: "Your GitHub username",
    tokenPlaceholder: "Your GitHub token (classic)",
    tokenHint: "Needed for private repos, organizations, and starred repositories",
    tokenSettingsPath: "/settings/tokens",
    tokenSteps: [
      "GitHub → Settings → Developer settings",
      "Personal access tokens → Generate new token (classic)",
      "Select the scopes below and paste the token here",
    ],
    scopes: ["repo", "admin:org"],
  },
  {
    value: "gitlab",
    label: SOURCE_PROVIDER_LABELS.gitlab,
    icon: SiGitlab,
    badge: isBetaSourceProvider("gitlab") ? "BETA" : undefined,
    usernamePlaceholder: "Your GitLab username",
    tokenPlaceholder: "Your GitLab personal access token",
    tokenHint: "Needed for private projects, groups, and starred projects",
    tokenSettingsPath: "/-/user_settings/personal_access_tokens",
    tokenSteps: [
      "GitLab → Preferences → Access tokens",
      "Add new token with the scopes below",
      "Paste the token here",
    ],
    scopes: ["read_api", "read_repository"],
  },
  {
    value: "gitea",
    label: SOURCE_PROVIDER_LABELS.gitea,
    icon: SiGitea,
    badge: isBetaSourceProvider("gitea") ? "BETA" : undefined,
    usernamePlaceholder: "Your Gitea or Forgejo username",
    tokenPlaceholder: "Your access token",
    tokenHint: "Needed for private repos, organizations, and starred repositories",
    tokenSettingsPath: "/user/settings/applications",
    tokenSteps: [
      "Gitea → Settings → Applications",
      "Generate a token with the permissions below",
      "Paste the token here",
    ],
    scopes: ["read:repository", "read:user", "read:organization"],
  },
];

function providerMetaFor(provider: SourceProvider): SourceProviderMeta {
  return sourceProviders.find((option) => option.value === provider) ?? sourceProviders[0];
}

function providerHelp(provider: SourceProvider): string {
  if (provider === "github") return "Where your repositories are pulled from";
  if (provider === "gitlab")
    return "Beta. Code, tags, wiki and LFS are mirrored. Issues, merge requests and releases need a GitHub source.";
  return "Beta. Code, tags, wiki and LFS are mirrored. Issues, pull requests and releases need a GitHub source.";
}

function sourceHost(source: SourceApiRecord): string {
  const url = (source.url ?? "").trim() || SOURCE_PROVIDER_DEFAULT_URLS[source.provider];
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function repositoryNoun(count: number): string {
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

const sourceChangeConsequences = [
  "Repositories already imported stay tied to the current source and keep syncing through Gitea.",
  "Cleanup ignores them, and mirroring one of them again is refused until it is removed and added from the new source.",
  "New imports come from the new source only.",
];

interface SourcesCardProps {
  /** Connected sources from the config API; empty until one is added. */
  sources: SourceApiRecord[];
  /** Refetches the config so the list, locks and counts stay fresh. */
  onRefresh: () => Promise<void>;
}

type SourcesMutationResponse = {
  success?: boolean;
  message?: string;
  /** Present when a locked source change needs explicit confirmation. */
  lock?: string;
  source?: SourceApiRecord;
};

type EditorState = {
  /** Source being edited; null when adding a new one. */
  source: SourceApiRecord | null;
  provider: SourceProvider;
  url: string;
  username: string;
  token: string;
  /** Set once the lock dialog confirmed changing provider or instance URL. */
  sourceUnlocked: boolean;
};

/**
 * The Connections tab source card: one row per connected source, with the
 * add/edit form reusing the connection fields of the single-source era.
 */
export function SourcesCard({ sources, onRefresh }: SourcesCardProps) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [confirmChangeMessage, setConfirmChangeMessage] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SourceApiRecord | null>(null);

  const editing = editor?.source ?? null;
  const editingLocked = Boolean(editing?.locked) && !editor?.sourceUnlocked;
  const provider = editor?.provider ?? "github";
  const providerMeta = providerMetaFor(provider);
  const providerLabel = providerMeta.label;
  const defaultInstanceUrl = SOURCE_PROVIDER_DEFAULT_URLS[provider];
  const instanceUrl = (editor?.url ?? "").trim() || defaultInstanceUrl;
  const tokenSettingsUrl = `${instanceUrl.replace(/\/+$/, "")}${providerMeta.tokenSettingsPath}`;
  // An empty token field while editing keeps the stored one, so testing
  // and saving both fall back to it.
  const effectiveToken = editor?.token.trim() || editing?.token || "";

  const refreshSources = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  // Raw fetch (like ConfigTabs's config save) so 409 bodies with a lock
  // flag can be distinguished from plain validation errors.
  const requestMutation = async (
    path: string,
    init: RequestInit
  ): Promise<{ ok: boolean; status: number; body: SourcesMutationResponse }> => {
    const response = await fetch(`${SOURCES_API_PATH}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  };

  const openAddEditor = () => {
    setEditor({
      source: null,
      provider: "github",
      url: "",
      username: "",
      token: "",
      sourceUnlocked: false,
    });
  };

  const openEditEditor = (source: SourceApiRecord) => {
    setEditor({
      source,
      provider: source.provider,
      url: source.url ?? "",
      username: source.username ?? "",
      token: "",
      sourceUnlocked: false,
    });
  };

  const handleProviderChange = (value: string) => {
    setEditor((prev) => {
      if (!prev) return prev;
      const nextProvider = value as SourceProvider;
      return {
        ...prev,
        provider: nextProvider,
      };
    });
  };

  const handleFieldChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setEditor((prev) => (prev ? { ...prev, [name]: value } : prev));
  };

  const handleTestConnection = async () => {
    if (!editor) return;
    if (!effectiveToken) {
      toast.error(`${providerLabel} token is required to test the connection`);
      return;
    }

    setIsTesting(true);

    try {
      const result = await githubApi.testConnection(effectiveToken, {
        provider,
        url: editor.url.trim() || undefined,
        username: editor.username.trim() || undefined,
      });
      if (result.success) {
        toast.success(result.message || `Successfully connected to ${providerLabel}!`);
      } else {
        toast.error(
          result.message || `Failed to connect to ${providerLabel}. Please check your token.`
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "An unknown error occurred"
      );
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async (confirmSourceChange: boolean) => {
    if (!editor) return;
    setIsSaving(true);

    try {
      const body: Record<string, unknown> = {
        provider,
        username: editor.username.trim(),
      };
      if (editor.url.trim()) {
        body.url = editor.url.trim();
      }
      // Empty token on edit keeps the stored one (existing save convention).
      if (!editing || editor.token.trim()) {
        body.token = editor.token.trim();
      }
      if (editing && (confirmSourceChange || editor.sourceUnlocked)) {
        body.confirmSourceChange = true;
      }

      const { ok, status, body: result } = await requestMutation(
        editing ? `/${editing.id}` : "",
        { method: editing ? "PUT" : "POST", body: JSON.stringify(body) }
      );

      if (ok) {
        toast.success(editing ? "Source updated" : "Source added");
        setEditor(null);
        invalidateConfigCache();
        await refreshSources();
        return;
      }

      if (status === 409 && result.lock === "source") {
        setConfirmChangeMessage(
          result.message ||
            `${repositoryNoun(editing?.repositoryCount ?? 0)} were imported from this source.`
        );
        return;
      }

      toast.error(
        result.message || `Failed to ${editing ? "update" : "add"} source. Please try again.`
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "An unknown error occurred"
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    setIsRemoving(true);

    try {
      const { ok, body: result } = await requestMutation(`/${removeTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmRemoveSource: true }),
      });

      if (ok) {
        toast.success("Source removed");
        setRemoveTarget(null);
        invalidateConfigCache();
        await refreshSources();
        return;
      }

      toast.error(result.message || "Failed to remove source. Please try again.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "An unknown error occurred"
      );
    } finally {
      setIsRemoving(false);
    }
  };

  const isBusy = isSaving || isRemoving || isRefreshing;

  return (
    <SettingsCard
      icon={Layers}
      title="Sources"
      headerAction={
        <div className="flex items-center gap-3">
          {isBusy && (
            <Activity className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openAddEditor}
            disabled={editor !== null || isSaving}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Source
          </Button>
        </div>
      }
    >
      {editor && (
        <>
          <CardSection>
            <div className="space-y-1.5">
              <Label
                htmlFor="source-provider"
                className="text-xs font-medium text-muted-foreground"
              >
                Source
              </Label>
              <Select value={provider} onValueChange={handleProviderChange} disabled={editingLocked}>
                <SelectTrigger id="source-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceProviders.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex items-center gap-2">
                        <option.icon className="h-3.5 w-3.5" />
                        {option.label}
                        {option.badge && (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-muted-foreground">
                            {option.badge}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground/80">
                {providerHelp(provider)}
              </p>
              {editing?.locked && (
                <HostLockNotice
                  summary={`${editing.repositoryCount} ${
                    editing.repositoryCount === 1 ? "repository was" : "repositories were"
                  } imported from ${providerLabel}`}
                  title="Change the source?"
                  consequences={sourceChangeConsequences}
                  changeLabel="Change source"
                  unlocked={editor.sourceUnlocked}
                  onUnlock={() =>
                    setEditor((prev) =>
                      prev ? { ...prev, sourceUnlocked: true } : prev
                    )
                  }
                />
              )}
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="source-url"
                className="text-xs font-medium text-muted-foreground"
              >
                Instance URL
              </Label>
                <Input
                  id="source-url"
                  name="url"
                  type="url"
                  value={editor.url}
                  onChange={handleFieldChange}
                  placeholder={defaultInstanceUrl}
                  disabled={editingLocked}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  {`Leave empty for ${defaultInstanceUrl.replace(/^https?:\/\//, "")}, or enter the base URL of your own instance`}
                </p>
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="source-username"
                className="text-xs font-medium text-muted-foreground"
              >
                Username
              </Label>
              <Input
                id="source-username"
                name="username"
                type="text"
                value={editor.username}
                onChange={handleFieldChange}
                placeholder={providerMeta.usernamePlaceholder}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="source-token"
                className="text-xs font-medium text-muted-foreground"
              >
                Personal access token
              </Label>
              <Input
                id="source-token"
                name="token"
                type="password"
                value={editor.token}
                onChange={handleFieldChange}
                placeholder={
                  editing
                    ? "leave empty to keep the current token"
                    : providerMeta.tokenPlaceholder
                }
              />
              <p className="text-[11px] text-muted-foreground/80">
                {providerMeta.tokenHint}
              </p>
            </div>

            <div className="space-y-3 rounded-lg bg-muted/40 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <span className="text-[13px] font-semibold text-muted-foreground">
                    Creating your token
                  </span>
                </div>
                <a
                  href={tokenSettingsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${tokenSettingsUrl.replace(/^https?:\/\//, "")}`}
                  aria-label={`Open ${providerLabel} token settings`}
                  className="text-indigo-500 hover:text-indigo-400"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
              <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
                {providerMeta.tokenSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <div className="flex flex-wrap items-center gap-2">
                {providerMeta.scopes.map((scope) => (
                  <code
                    key={scope}
                    className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {scope}
                  </code>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={isTesting || !effectiveToken}
              >
                <PlugZap className="mr-1.5 h-3.5 w-3.5" />
                {isTesting ? "Testing..." : "Test"}
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditor(null)}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleSave(false)}
                  disabled={isSaving || !editor.username.trim()}
                >
                  {isSaving ? "Saving..." : editing ? "Save changes" : "Add source"}
                </Button>
              </div>
            </div>
          </CardSection>
          {sources.length > 0 && <CardDivider />}
        </>
      )}

      <CardSection>
        {sources.length === 0 && !editor ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No sources connected yet — add one to start mirroring.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={openAddEditor}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Source
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {sources.map((source) => {
              const meta = providerMetaFor(source.provider);
              const ProviderIcon = meta.icon;
              return (
                <div
                  key={source.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border p-3.5"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ProviderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="text-sm font-medium leading-none">
                        {source.name || meta.label}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {meta.label}
                      </span>
                      {meta.badge && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-muted-foreground">
                          {meta.badge}
                        </span>
                      )}
                      {source.locked && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          <Lock className="h-3 w-3" />
                          Locked
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[13px] text-muted-foreground">
                      {[
                        sourceHost(source),
                        source.username,
                        repositoryNoun(source.repositoryCount),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEditEditor(source)}
                      disabled={isBusy}
                      title="Edit source"
                      aria-label={`Edit ${source.name || meta.label} source`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => setRemoveTarget(source)}
                      disabled={isBusy}
                      title="Remove source"
                      aria-label={`Remove ${source.name || meta.label} source`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardSection>

      <Dialog open={confirmChangeMessage !== null} onOpenChange={(open) => !open && setConfirmChangeMessage(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Change the source?</DialogTitle>
            <DialogDescription>{confirmChangeMessage}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {sourceChangeConsequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmChangeMessage(null)}
            >
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmChangeMessage(null);
                handleSave(true);
              }}
            >
              Change source
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Remove source?</DialogTitle>
            <DialogDescription>
              {removeTarget && removeTarget.repositoryCount > 0
                ? `${repositoryNoun(removeTarget.repositoryCount)} were imported from this source. They keep syncing on the destination with their stored credentials.`
                : "No repositories were imported from this source. Removing it only disconnects the credentials."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={isRemoving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleRemove}
              disabled={isRemoving}
            >
              {isRemoving ? "Removing..." : "Remove source"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
}
