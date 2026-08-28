import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { githubApi } from "@/lib/api";
import type { GitHubConfig, MirrorOptions, AdvancedOptions, GiteaConfig, BackupStrategy } from "@/types/config";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toast } from "sonner";
import {
  Activity,
  CircleOff,
  DatabaseBackup,
  Hand,
  PlugZap,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { SiGithub } from "react-icons/si";
import { GitHubMirrorSettings } from "./GitHubMirrorSettings";
import {
  SettingsCard,
  SectionTitle,
  SwitchRow,
  OptionTile,
  StatusFooterItem,
  CardDivider,
  CardSection,
} from "./settings-ui";
import { TokenCreationGuide } from "./TokenCreationGuide";

interface GitHubConfigFormProps {
  config: GitHubConfig;
  setConfig: React.Dispatch<React.SetStateAction<GitHubConfig>>;
  mirrorOptions: MirrorOptions;
  setMirrorOptions: React.Dispatch<React.SetStateAction<MirrorOptions>>;
  advancedOptions: AdvancedOptions;
  setAdvancedOptions: React.Dispatch<React.SetStateAction<AdvancedOptions>>;
  giteaConfig?: GiteaConfig;
  setGiteaConfig?: React.Dispatch<React.SetStateAction<GiteaConfig>>;
  onAutoSave?: (githubConfig: GitHubConfig) => Promise<void>;
  onMirrorOptionsAutoSave?: (mirrorOptions: MirrorOptions) => Promise<void>;
  onAdvancedOptionsAutoSave?: (advancedOptions: AdvancedOptions) => Promise<void>;
  onGiteaAutoSave?: (giteaConfig: GiteaConfig) => Promise<void>;
  isAutoSaving?: boolean;
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
    description: "Snapshot only on history rewrites",
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
  part = "connection"
}: GitHubConfigFormProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;

    const newConfig = {
      ...config,
      [name]: type === "checkbox" ? checked : value,
    };

    setConfig(newConfig);

    // Auto-save for all field changes
    if (onAutoSave) {
      onAutoSave(newConfig);
    }
  };

  const testConnection = async () => {
    if (!config.token) {
      toast.error("GitHub token is required to test the connection");
      return;
    }

    setIsLoading(true);

    try {
      const result = await githubApi.testConnection(config.token);
      if (result.success) {
        toast.success("Successfully connected to GitHub!");
      } else {
        toast.error("Failed to connect to GitHub. Please check your token.");
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
        icon={SiGithub}
        title="GitHub Connection"
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
              placeholder="Your GitHub username"
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
              placeholder="Your GitHub token (classic)"
            />
            <p className="text-[11px] text-muted-foreground/80">
              Needed for private repos, organizations, and starred repositories
            </p>
          </div>

          <TokenCreationGuide
            settingsUrl="https://github.com/settings/tokens"
            settingsTitle="Open GitHub token settings"
            steps={[
              "GitHub → Settings → Developer settings",
              "Personal access tokens → Generate new token (classic)",
              "Select the scopes below and paste the token here",
            ]}
            scopes={["repo", "admin:org"]}
          />
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
