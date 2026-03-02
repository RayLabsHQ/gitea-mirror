import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { githubApi } from "@/lib/api";
import type { GitHubConfig, MirrorOptions, AdvancedOptions, GiteaConfig, BackupStrategy } from "@/types/config";
import { Input } from "../ui/input";
import { toast } from "sonner";
import { Info, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { GitHubMirrorSettings } from "./GitHubMirrorSettings";
import { Separator } from "../ui/separator";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

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
}

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
  isAutoSaving
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

  return (
    <Card className="w-full h-full flex flex-col">
      <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <CardTitle className="text-lg font-semibold">
          GitHub Configuration
        </CardTitle>
        {/* Desktop: Show button in header */}
        <Button
          type="button"
          variant="default"
          onClick={testConnection}
          disabled={isLoading || !config.token}
          className="hidden sm:inline-flex"
        >
          {isLoading ? "Testing..." : "Test Connection"}
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-y-6 flex-1">
        <div>
          <label
            htmlFor="github-username"
            className="block text-sm font-medium mb-1.5"
          >
            GitHub Username
          </label>
          <Input
            id="github-username"
            name="username"
            type="text"
            value={config.username}
            onChange={handleChange}
            placeholder="Your GitHub username"
            required
            className="bg-background"
          />
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <label
              htmlFor="github-token"
              className="block text-sm font-medium"
            >
              GitHub Token
            </label>
            <HoverCard openDelay={200}>
              <HoverCardTrigger asChild>
                <span className="inline-flex p-0.5 hover:bg-muted rounded-sm transition-colors cursor-help">
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              </HoverCardTrigger>
              <HoverCardContent side="right" align="start" className="w-80">
                <div className="space-y-2">
                  <h4 className="font-medium text-sm">GitHub Token Requirements</h4>
                  <div className="text-sm space-y-2">
                    <p>
                      You need to create a <span className="font-medium">Classic GitHub PAT Token</span> with the following scopes:
                    </p>
                    <ul className="ml-4 space-y-1 list-disc">
                      <li><code className="text-xs bg-muted px-1 py-0.5 rounded">repo</code></li>
                      <li><code className="text-xs bg-muted px-1 py-0.5 rounded">admin:org</code></li>
                    </ul>
                    <p className="text-muted-foreground">
                      The organization access is required for mirroring organization repositories.
                    </p>
                    <p>
                      Generate tokens at{" "}
                      <a
                        href="https://github.com/settings/tokens"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline font-medium"
                      >
                        github.com/settings/tokens
                      </a>
                    </p>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </div>
          <Input
            id="github-token"
            name="token"
            type="password"
            value={config.token}
            onChange={handleChange}
            className="bg-background"
            placeholder="Your GitHub token (classic) with repo and admin:org scopes"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Required for private repositories, organizations, and starred
            repositories.
          </p>
        </div>

        <Separator />

        <GitHubMirrorSettings
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

        {giteaConfig && setGiteaConfig && (
          <>
            <Separator />

            <div className="space-y-4">
              <h3 className="text-sm font-medium flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-primary" />
                Destructive Update Protection
                <Badge variant="secondary" className="ml-2 text-[10px] px-1.5 py-0">BETA</Badge>
              </h3>
              <p className="text-xs text-muted-foreground">
                Choose how to handle force-pushes or rewritten upstream history on GitHub.
              </p>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {([
                  {
                    value: "disabled",
                    label: "Disabled",
                    desc: "No detection or backups",
                  },
                  {
                    value: "always",
                    label: "Always Backup",
                    desc: "Snapshot before every sync",
                  },
                  {
                    value: "on-force-push",
                    label: "Smart",
                    desc: "Backup only on force-push",
                  },
                  {
                    value: "block-on-force-push",
                    label: "Block & Approve",
                    desc: "Require approval on force-push",
                  },
                ] as const).map((opt) => {
                  const isSelected = (giteaConfig.backupStrategy ?? "on-force-push") === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        const newConfig = { ...giteaConfig, backupStrategy: opt.value as BackupStrategy };
                        setGiteaConfig(newConfig);
                        if (onGiteaAutoSave) onGiteaAutoSave(newConfig);
                      }}
                      className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left text-sm transition-colors ${
                        isSelected
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-input hover:bg-accent hover:text-accent-foreground"
                      }`}
                    >
                      <span className="font-medium">{opt.label}</span>
                      <span className="text-xs text-muted-foreground">{opt.desc}</span>
                    </button>
                  );
                })}
              </div>

              {(giteaConfig.backupStrategy ?? "on-force-push") !== "disabled" && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="backup-retention" className="block text-sm font-medium mb-1.5">
                        Snapshot retention count
                      </label>
                      <input
                        id="backup-retention"
                        name="backupRetentionCount"
                        type="number"
                        min={1}
                        value={giteaConfig.backupRetentionCount ?? 20}
                        onChange={(e) => {
                          const newConfig = {
                            ...giteaConfig,
                            backupRetentionCount: Math.max(1, Number.parseInt(e.target.value, 10) || 20),
                          };
                          setGiteaConfig(newConfig);
                          if (onGiteaAutoSave) onGiteaAutoSave(newConfig);
                        }}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                    </div>
                    <div>
                      <label htmlFor="backup-directory" className="block text-sm font-medium mb-1.5">
                        Snapshot directory
                      </label>
                      <input
                        id="backup-directory"
                        name="backupDirectory"
                        type="text"
                        value={giteaConfig.backupDirectory || "data/repo-backups"}
                        onChange={(e) => {
                          const newConfig = { ...giteaConfig, backupDirectory: e.target.value };
                          setGiteaConfig(newConfig);
                          if (onGiteaAutoSave) onGiteaAutoSave(newConfig);
                        }}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="data/repo-backups"
                      />
                    </div>
                  </div>

                  {((giteaConfig.backupStrategy ?? "on-force-push") === "always" ||
                    (giteaConfig.backupStrategy ?? "on-force-push") === "on-force-push") && (
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        name="blockSyncOnBackupFailure"
                        type="checkbox"
                        checked={Boolean(giteaConfig.blockSyncOnBackupFailure)}
                        onChange={(e) => {
                          const newConfig = { ...giteaConfig, blockSyncOnBackupFailure: e.target.checked };
                          setGiteaConfig(newConfig);
                          if (onGiteaAutoSave) onGiteaAutoSave(newConfig);
                        }}
                        className="mt-0.5 rounded border-input"
                      />
                      <span>
                        Block sync when snapshot fails
                        <p className="text-xs text-muted-foreground">
                          Recommended for backup-first behavior. If disabled, sync continues even when snapshot creation fails.
                        </p>
                      </span>
                    </label>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* Mobile: Show button at bottom */}
        <Button
          type="button"
          variant="default"
          onClick={testConnection}
          disabled={isLoading || !config.token}
          className="sm:hidden w-full"
        >
          {isLoading ? "Testing..." : "Test Connection"}
        </Button>
    </CardContent>

    </Card>
  );
}
