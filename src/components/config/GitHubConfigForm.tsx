import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { githubApi } from "@/lib/api";
import type {
  GitHubConfig,
  MirrorOptions,
  AdvancedOptions,
  GiteaConfig,
  BackupStrategy,
  SourceProvider,
  ConfigLockState,
} from "@/types/config";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toast } from "sonner";
import {
  Activity,
  CircleOff,
  DatabaseBackup,
  ExternalLink,
  Hand,
  KeyRound,
  PlugZap,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { SiGitea, SiGithub, SiGitlab } from "react-icons/si";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SOURCE_PROVIDER_DEFAULT_URLS,
  SOURCE_PROVIDER_LABELS,
  isBetaSourceProvider,
} from "@/lib/source-providers/kinds";
import { GitHubMirrorSettings } from "./GitHubMirrorSettings";
import { HostLockNotice } from "./HostLockNotice";
import {
  SettingsCard,
  SectionTitle,
  SwitchRow,
  OptionTile,
  StatusFooterItem,
  CardDivider,
  CardSection,
} from "./settings-ui";

interface GitHubConfigFormProps {
  config: GitHubConfig;
  setConfig: React.Dispatch<React.SetStateAction<GitHubConfig>>;
  mirrorOptions: MirrorOptions;
  setMirrorOptions: React.Dispatch<React.SetStateAction<MirrorOptions>>;
  advancedOptions: AdvancedOptions;
  setAdvancedOptions: React.Dispatch<React.SetStateAction<AdvancedOptions>>;
  giteaConfig?: GiteaConfig;
  setGiteaConfig?: React.Dispatch<React.SetStateAction<GiteaConfig>>;
  onAutoSave?: (
    githubConfig: GitHubConfig,
    options?: { confirmSourceChange?: boolean }
  ) => Promise<void>;
  onMirrorOptionsAutoSave?: (mirrorOptions: MirrorOptions) => Promise<void>;
  onAdvancedOptionsAutoSave?: (advancedOptions: AdvancedOptions) => Promise<void>;
  onGiteaAutoSave?: (
    giteaConfig: GiteaConfig,
    options?: { confirmDestinationChange?: boolean }
  ) => Promise<void>;
  isAutoSaving?: boolean;
  /** Set once repositories were imported: the source can only change with confirmation. */
  sourceLock?: ConfigLockState["source"];
  /** Which card group to render: the connection card, or the settings stack
   *  (repository selection + destructive update protection). */
  part?: "connection" | "settings";
}

const backupStrategies = [
  {
    value: "disabled" as const,
    label: "Disabled",
    description: "Force-pushes sync straight through",
    icon: CircleOff,
    info: "No detection or backups. Rewritten upstream history overwrites your mirror.",
  },
  {
    value: "always" as const,
    label: "Always Backup",
    description: "Snapshot before every sync",
    icon: DatabaseBackup,
    info: "Maximum safety at the cost of disk usage.",
  },
  {
    value: "on-force-push" as const,
    label: "Smart",
    description: "Snapshot only on rewrites",
    icon: Sparkles,
    info: "Backs up only when a force-push is detected.",
  },
  {
    value: "block-on-force-push" as const,
    label: "Block & Approve",
    description: "Hold sync until you approve",
    icon: Hand,
    info: "Force-pushed repos pause syncing until you approve the update.",
  },
];

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

export function GitHubConfigForm({
  config,
  setConfig,
  mirrorOptions,
  setMirrorOptions,
  advancedOptions,
  setAdvancedOptions,
  giteaConfig,
  setGiteaConfig,
  onAutoSave,
  onMirrorOptionsAutoSave,
  onAdvancedOptionsAutoSave,
  onGiteaAutoSave,
  isAutoSaving,
  sourceLock,
  part = "connection"
}: GitHubConfigFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [sourceUnlocked, setSourceUnlocked] = useState(false);
  const sourceLocked = Boolean(sourceLock?.locked) && !sourceUnlocked;

  const provider: SourceProvider = config.provider ?? "github";
  const providerMeta =
    sourceProviders.find((option) => option.value === provider) ?? sourceProviders[0];
  const providerLabel = providerMeta.label;
  const defaultInstanceUrl = SOURCE_PROVIDER_DEFAULT_URLS[provider];
  const instanceUrl = (config.url ?? "").trim() || defaultInstanceUrl;
  const tokenSettingsUrl = `${instanceUrl.replace(/\/+$/, "")}${providerMeta.tokenSettingsPath}`;

  const handleProviderChange = (value: string) => {
    const nextProvider = value as SourceProvider;
    const newConfig: GitHubConfig = {
      ...config,
      provider: nextProvider,
      // GitHub has no per-config instance URL (GHES routing uses GH_API_URL).
      url: nextProvider === "github" ? "" : config.url ?? "",
    };
    setConfig(newConfig);
    if (onAutoSave) {
      onAutoSave(newConfig, { confirmSourceChange: sourceUnlocked });
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;

    const newConfig = {
      ...config,
      [name]: type === "checkbox" ? checked : value,
    };

    setConfig(newConfig);

    // Auto-save for all field changes. Once the source was unlocked through
    // the dialog, the save carries the confirmation the API requires.
    if (onAutoSave) {
      onAutoSave(newConfig, { confirmSourceChange: sourceUnlocked });
    }
  };

  const testConnection = async () => {
    if (!config.token) {
      toast.error(`${providerLabel} token is required to test the connection`);
      return;
    }

    setIsLoading(true);

    try {
      const result = await githubApi.testConnection(config.token, {
        provider,
        url: config.url,
      });
      if (result.success) {
        toast.success(`Successfully connected to ${providerLabel}!`);
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
      setIsLoading(false);
    }
  };

  const updateGitea = (newConfig: GiteaConfig) => {
    if (!setGiteaConfig) return;
    setGiteaConfig(newConfig);
    if (onGiteaAutoSave) onGiteaAutoSave(newConfig);
  };

  const backupStrategy = giteaConfig?.backupStrategy ?? "on-force-push";

  if (part === "connection") {
    return (
      <SettingsCard
        icon={providerMeta.icon}
        title={`${providerLabel} Connection`}
        headerAction={
          <div className="flex items-center gap-3">
            {isAutoSaving && (
              <Activity className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={testConnection}
              disabled={isLoading || !config.token}
            >
              <PlugZap className="mr-1.5 h-3.5 w-3.5" />
              {isLoading ? "Testing..." : "Test"}
            </Button>
          </div>
        }
      >
        <CardSection>
          <div className="space-y-1.5">
            <Label
              htmlFor="source-provider"
              className="text-xs font-medium text-muted-foreground"
            >
              Source
            </Label>
            <Select value={provider} onValueChange={handleProviderChange} disabled={sourceLocked}>
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
              {provider === "github"
                ? "Where your repositories are pulled from"
                : provider === "gitlab"
                  ? "Beta. Code, tags, wiki and LFS are mirrored. Issues, merge requests and releases need a GitHub source."
                  : "Beta. Code, tags, wiki and LFS are mirrored. Issues, pull requests and releases need a GitHub source."}
            </p>
            {sourceLock?.locked && (
              <HostLockNotice
                summary={`${sourceLock.repositoryCount} ${
                  sourceLock.repositoryCount === 1 ? "repository was" : "repositories were"
                } imported from ${providerLabel}`}
                title="Change the source?"
                consequences={[
                  "Repositories already imported stay tied to the current source and keep syncing through Gitea.",
                  "Cleanup ignores them, and mirroring one of them again is refused until it is removed and added from the new source.",
                  "New imports come from the new source only.",
                ]}
                changeLabel="Change source"
                unlocked={sourceUnlocked}
                onUnlock={() => setSourceUnlocked(true)}
              />
            )}
          </div>

          {provider !== "github" && (
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
                value={config.url ?? ""}
                onChange={handleChange}
                placeholder={defaultInstanceUrl}
                disabled={sourceLocked}
              />
              <p className="text-[11px] text-muted-foreground/80">
                {`Leave empty for ${defaultInstanceUrl.replace(/^https?:\/\//, "")}, or enter the base URL of your own instance`}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label
              htmlFor="github-username"
              className="text-xs font-medium text-muted-foreground"
            >
              Username
            </Label>
            <Input
              id="github-username"
              name="username"
              type="text"
              value={config.username}
              onChange={handleChange}
              placeholder={providerMeta.usernamePlaceholder}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="github-token"
              className="text-xs font-medium text-muted-foreground"
            >
              Personal access token
            </Label>
            <Input
              id="github-token"
              name="token"
              type="password"
              value={config.token}
              onChange={handleChange}
              placeholder={providerMeta.tokenPlaceholder}
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
        </CardSection>
      </SettingsCard>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <GitHubMirrorSettings
        part="selection"
        githubConfig={config}
        mirrorOptions={mirrorOptions}
        advancedOptions={advancedOptions}
        onGitHubConfigChange={(newConfig) => {
          setConfig(newConfig);
          if (onAutoSave) onAutoSave(newConfig);
        }}
        onMirrorOptionsChange={(newOptions) => {
          setMirrorOptions(newOptions);
          if (onMirrorOptionsAutoSave) onMirrorOptionsAutoSave(newOptions);
        }}
        onAdvancedOptionsChange={(newOptions) => {
          setAdvancedOptions(newOptions);
          if (onAdvancedOptionsAutoSave) onAdvancedOptionsAutoSave(newOptions);
        }}
      />

      {/* Destructive Update Protection */}
      {giteaConfig && setGiteaConfig && (
        <SettingsCard
          icon={ShieldAlert}
          title="Destructive Update Protection"
          footer={
            <StatusFooterItem
              icon={ShieldCheck}
              label="Applies to Always Backup and Smart modes"
            />
          }
        >
          <CardSection>
            <SectionTitle>How to handle force-pushes on GitHub</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {backupStrategies.map((opt) => (
                <OptionTile
                  key={opt.value}
                  icon={opt.icon}
                  label={opt.label}
                  description={opt.description}
                  info={opt.info}
                  selected={backupStrategy === opt.value}
                  onSelect={() =>
                    updateGitea({
                      ...giteaConfig,
                      backupStrategy: opt.value as BackupStrategy,
                    })
                  }
                />
              ))}
            </div>
          </CardSection>

          {backupStrategy !== "disabled" && (
            <>
              <CardDivider />
              <CardSection>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="backup-retention"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Snapshot retention count
                    </Label>
                    <Input
                      id="backup-retention"
                      name="backupRetentionCount"
                      type="number"
                      min={1}
                      value={giteaConfig.backupRetentionCount ?? 5}
                      onChange={(e) =>
                        updateGitea({
                          ...giteaConfig,
                          backupRetentionCount: Math.max(1, Number.parseInt(e.target.value, 10) || 5),
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="backup-retention-days"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Snapshot retention days
                    </Label>
                    <Input
                      id="backup-retention-days"
                      name="backupRetentionDays"
                      type="number"
                      min={0}
                      value={giteaConfig.backupRetentionDays ?? 30}
                      onChange={(e) =>
                        updateGitea({
                          ...giteaConfig,
                          backupRetentionDays: Math.max(0, Number.parseInt(e.target.value, 10) || 0),
                        })
                      }
                    />
                    <p className="text-[11px] text-muted-foreground/80">
                      0 = no time-based limit
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="backup-directory"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Snapshot directory
                    </Label>
                    <Input
                      id="backup-directory"
                      name="backupDirectory"
                      type="text"
                      value={giteaConfig.backupDirectory || "data/repo-backups"}
                      onChange={(e) =>
                        updateGitea({ ...giteaConfig, backupDirectory: e.target.value })
                      }
                      placeholder="data/repo-backups"
                    />
                  </div>
                </div>

                {(backupStrategy === "always" || backupStrategy === "on-force-push") && (
                  <SwitchRow
                    label="Block sync when snapshot fails"
                    description="Recommended so a failed backup never lets a destructive sync through"
                    checked={Boolean(giteaConfig.blockSyncOnBackupFailure)}
                    onCheckedChange={(checked) =>
                      updateGitea({ ...giteaConfig, blockSyncOnBackupFailure: checked })
                    }
                  />
                )}
              </CardSection>
            </>
          )}
        </SettingsCard>
      )}
    </div>
  );
}
