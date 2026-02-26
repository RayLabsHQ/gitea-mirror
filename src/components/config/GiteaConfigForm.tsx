import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { giteaApi } from "@/lib/api";
import type { GiteaConfig, MirrorStrategy } from "@/types/config";
import { toast } from "sonner";
import { OrganizationStrategy } from "./OrganizationStrategy";
import { OrganizationConfiguration } from "./OrganizationConfiguration";
import { Separator } from "../ui/separator";

interface GiteaConfigFormProps {
  config: GiteaConfig;
  setConfig: React.Dispatch<React.SetStateAction<GiteaConfig>>;
  onAutoSave?: (giteaConfig: GiteaConfig) => Promise<void>;
  isAutoSaving?: boolean;
  githubUsername?: string;
}

export function GiteaConfigForm({ config, setConfig, onAutoSave, isAutoSaving, githubUsername }: GiteaConfigFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  
  // Derive the mirror strategy from existing config for backward compatibility
  const getMirrorStrategy = (): MirrorStrategy => {
    if (config.mirrorStrategy) return config.mirrorStrategy;
    // Check for mixed mode: when we have both organization and personalReposOrg defined
    if (config.organization && config.personalReposOrg && !config.preserveOrgStructure) return "mixed";
    if (config.preserveOrgStructure) return "preserve";
    if (config.organization && config.organization !== config.username) return "single-org";
    return "flat-user";
  };
  
  const [mirrorStrategy, setMirrorStrategy] = useState<MirrorStrategy>(getMirrorStrategy());
  
  // Update config when strategy changes
  useEffect(() => {
    const newConfig = { ...config };
    
    switch (mirrorStrategy) {
      case "preserve":
        newConfig.preserveOrgStructure = true;
        newConfig.mirrorStrategy = "preserve";
        newConfig.personalReposOrg = undefined; // Clear personal repos org in preserve mode
        break;
      case "single-org":
        newConfig.preserveOrgStructure = false;
        newConfig.mirrorStrategy = "single-org";
        // Reset to default if coming from mixed mode where it was personal repos org
        if (config.mirrorStrategy === "mixed" || !newConfig.organization || newConfig.organization === "github-personal") {
          newConfig.organization = "github-mirrors";
        }
        break;
      case "flat-user":
        newConfig.preserveOrgStructure = false;
        newConfig.mirrorStrategy = "flat-user";
        newConfig.organization = "";
        break;
      case "mixed":
        newConfig.preserveOrgStructure = false;
        newConfig.mirrorStrategy = "mixed";
        // In mixed mode, organization field represents personal repos org
        // Reset it to default if coming from single-org mode
        if (config.mirrorStrategy === "single-org" || !newConfig.organization || newConfig.organization === "github-mirrors") {
          newConfig.organization = "github-personal";
        }
        if (!newConfig.personalReposOrg) {
          newConfig.personalReposOrg = "github-personal";
        }
        break;
    }
    
    setConfig(newConfig);
    if (onAutoSave) {
      onAutoSave(newConfig);
    }
  }, [mirrorStrategy]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    const checked = type === "checkbox" ? (e.target as HTMLInputElement).checked : undefined;

    // Special handling for preserveOrgStructure changes
    if (
      name === "preserveOrgStructure" &&
      config.preserveOrgStructure !== checked
    ) {
      toast.info(
        "Changing this setting may affect how repositories are accessed in Gitea. " +
          "Existing mirrored repositories will still be accessible during sync operations.",
        {
          duration: 6000,
          position: "top-center",
        }
      );
    }

    const normalizedValue =
      type === "checkbox"
        ? checked
        : name === "backupRetentionCount"
          ? Math.max(1, Number.parseInt(value, 10) || 20)
          : value;

    const newConfig = {
      ...config,
      [name]: normalizedValue,
    };
    setConfig(newConfig);

    // Auto-save for all field changes
    if (onAutoSave) {
      onAutoSave(newConfig);
    }
  };

  const testConnection = async () => {
    if (!config.url || !config.token) {
      toast.error("Gitea URL and token are required to test the connection");
      return;
    }

    setIsLoading(true);

    try {
      const result = await giteaApi.testConnection(config.url, config.token);
      if (result.success) {
        toast.success("Successfully connected to Gitea!");
      } else {
        toast.error(
          "Failed to connect to Gitea. Please check your URL and token."
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

  return (
    <Card className="w-full h-full flex flex-col">
      <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <CardTitle className="text-lg font-semibold">
          Gitea Configuration
        </CardTitle>
        {/* Desktop: Show button in header */}
        <Button
          type="button"
          variant="default"
          onClick={testConnection}
          disabled={isLoading || !config.url || !config.token}
          className="hidden sm:inline-flex"
        >
          {isLoading ? "Testing..." : "Test Connection"}
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-y-6 flex-1">
        <div>
          <label
            htmlFor="gitea-username"
            className="block text-sm font-medium mb-1.5"
          >
            Gitea Username
          </label>
          <input
            id="gitea-username"
            name="username"
            type="text"
            value={config.username}
            onChange={handleChange}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Your Gitea username"
            required
          />
        </div>

        <div>
          <label
            htmlFor="gitea-url"
            className="block text-sm font-medium mb-1.5"
          >
            Gitea URL
          </label>
          <input
            id="gitea-url"
            name="url"
            type="url"
            value={config.url}
            onChange={handleChange}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="https://your-gitea-instance.com"
            required
          />
        </div>

        <div>
          <label
            htmlFor="gitea-external-url"
            className="block text-sm font-medium mb-1.5"
          >
            Gitea External URL (optional)
          </label>
          <input
            id="gitea-external-url"
            name="externalUrl"
            type="url"
            value={config.externalUrl || ""}
            onChange={handleChange}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="https://gitea.example.com"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Used only for dashboard links. API sync still uses Gitea URL.
          </p>
        </div>

        <div>
          <label
            htmlFor="gitea-token"
            className="block text-sm font-medium mb-1.5"
          >
            Gitea Token
          </label>
          <input
            id="gitea-token"
            name="token"
            type="password"
            value={config.token}
            onChange={handleChange}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Your Gitea access token"
            required
          />
          <p className="text-xs text-muted-foreground mt-1">
            Create a token in your Gitea instance under Settings &gt;
            Applications.
          </p>
        </div>

        <Separator />
        
        <OrganizationStrategy
          strategy={mirrorStrategy}
          destinationOrg={config.organization}
          starredReposOrg={config.starredReposOrg}
          starredReposMode={config.starredReposMode}
          onStrategyChange={setMirrorStrategy}
          githubUsername={githubUsername}
          giteaUsername={config.username}
        />
        
        <Separator />
        
        <OrganizationConfiguration
          strategy={mirrorStrategy}
          destinationOrg={config.organization}
          starredReposOrg={config.starredReposOrg}
          starredReposMode={config.starredReposMode}
          personalReposOrg={config.personalReposOrg}
          visibility={config.visibility}
          onDestinationOrgChange={(org) => {
            const newConfig = { ...config, organization: org };
            setConfig(newConfig);
            if (onAutoSave) onAutoSave(newConfig);
          }}
          onStarredReposOrgChange={(org) => {
            const newConfig = { ...config, starredReposOrg: org };
            setConfig(newConfig);
            if (onAutoSave) onAutoSave(newConfig);
          }}
          onStarredReposModeChange={(mode) => {
            const newConfig = { ...config, starredReposMode: mode };
            setConfig(newConfig);
            if (onAutoSave) onAutoSave(newConfig);
          }}
          onPersonalReposOrgChange={(org) => {
            const newConfig = { ...config, personalReposOrg: org };
            setConfig(newConfig);
            if (onAutoSave) onAutoSave(newConfig);
          }}
          onVisibilityChange={(visibility) => {
            const newConfig = { ...config, visibility };
            setConfig(newConfig);
            if (onAutoSave) onAutoSave(newConfig);
          }}
        />

        <Separator />

        <div className="space-y-4">
          <h3 className="text-sm font-semibold">Destructive Update Protection</h3>
          <label className="flex items-start gap-3 text-sm">
            <input
              name="backupBeforeSync"
              type="checkbox"
              checked={Boolean(config.backupBeforeSync)}
              onChange={handleChange}
              className="mt-0.5 rounded border-input"
            />
            <span>
              Create snapshot before each sync
              <p className="text-xs text-muted-foreground">
                Saves a restore point so force-pushes or rewritten upstream history can be recovered.
              </p>
            </span>
          </label>

          {config.backupBeforeSync && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="gitea-backup-retention" className="block text-sm font-medium mb-1.5">
                  Snapshot retention count
                </label>
                <input
                  id="gitea-backup-retention"
                  name="backupRetentionCount"
                  type="number"
                  min={1}
                  value={config.backupRetentionCount ?? 20}
                  onChange={handleChange}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
              <div>
                <label htmlFor="gitea-backup-directory" className="block text-sm font-medium mb-1.5">
                  Snapshot directory
                </label>
                <input
                  id="gitea-backup-directory"
                  name="backupDirectory"
                  type="text"
                  value={config.backupDirectory || "data/repo-backups"}
                  onChange={handleChange}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="data/repo-backups"
                />
              </div>
            </div>
          )}

          <label className="flex items-start gap-3 text-sm">
            <input
              name="blockSyncOnBackupFailure"
              type="checkbox"
              checked={Boolean(config.blockSyncOnBackupFailure)}
              onChange={handleChange}
              className="mt-0.5 rounded border-input"
            />
            <span>
              Block sync when snapshot fails
              <p className="text-xs text-muted-foreground">
                Recommended for backup-first behavior. If disabled, sync continues even when snapshot creation fails.
              </p>
            </span>
          </label>
        </div>

        {/* Mobile: Show button at bottom */}
        <Button
          type="button"
          variant="default"
          onClick={testConnection}
          disabled={isLoading || !config.url || !config.token}
          className="sm:hidden w-full"
        >
          {isLoading ? "Testing..." : "Test Connection"}
        </Button>
      </CardContent>
    </Card>
  );
}
