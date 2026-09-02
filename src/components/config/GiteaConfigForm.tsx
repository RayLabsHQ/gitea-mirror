import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Activity, AlertTriangle, Building2, Info, PlugZap, UploadCloud } from "lucide-react";
import { SiForgejo, SiGitea, SiGithub, SiGitlab } from "react-icons/si";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DESTINATION_PROVIDER_DEFAULT_URLS,
  DESTINATION_PROVIDER_LABELS,
  DESTINATION_PROVIDER_ORG_NOUNS,
  PUSH_DESTINATION_TOKEN_SCOPES,
  isPushDestinationKind,
} from "@/lib/destination-kinds";
import { HostLockNotice } from "./HostLockNotice";
import { giteaApi, type GiteaServerInfo } from "@/lib/api";
import type {
  ConfigLockState,
  DestinationProvider,
  GiteaConfig,
  MirrorStrategy,
} from "@/types/config";
import { toast } from "sonner";
import { OrganizationStrategy } from "./OrganizationStrategy";
import { OrganizationConfiguration } from "./OrganizationConfiguration";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  SettingsCard,
  StatusFooterItem,
  CardDivider,
  CardSection,
} from "./settings-ui";

interface GiteaConfigFormProps {
  config: GiteaConfig;
  setConfig: React.Dispatch<React.SetStateAction<GiteaConfig>>;
  onAutoSave?: (
    giteaConfig: GiteaConfig,
    options?: { confirmDestinationChange?: boolean }
  ) => Promise<void>;
  isAutoSaving?: boolean;
  githubUsername?: string;
  /** Set once repositories were mirrored: the destination can only change with confirmation. */
  destinationLock?: ConfigLockState["destination"];
  /** Which card to render: the connection card or the organization card. */
  part?: "connection" | "organization";
}

const destinationProviders: {
  value: DestinationProvider;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Short pill shown next to the option, e.g. BETA. */
  badge?: string;
}[] = [
  { value: "gitea", label: DESTINATION_PROVIDER_LABELS.gitea, icon: SiGitea },
  { value: "forgejo", label: DESTINATION_PROVIDER_LABELS.forgejo, icon: SiForgejo },
  { value: "github", label: DESTINATION_PROVIDER_LABELS.github, icon: SiGithub, badge: "BETA" },
  { value: "gitlab", label: DESTINATION_PROVIDER_LABELS.gitlab, icon: SiGitlab, badge: "BETA" },
];

/** The public instance URLs a hosted target is prefilled with. */
const HOSTED_DEFAULT_URLS = new Set(Object.values(DESTINATION_PROVIDER_DEFAULT_URLS));

export function GiteaConfigForm({ config, setConfig, onAutoSave, isAutoSaving, githubUsername, destinationLock, part = "connection" }: GiteaConfigFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [destinationUnlocked, setDestinationUnlocked] = useState(false);
  const destinationLocked = Boolean(destinationLock?.locked) && !destinationUnlocked;
  const provider: DestinationProvider = config.provider ?? "gitea";
  const providerMeta =
    destinationProviders.find((option) => option.value === provider) ?? destinationProviders[0];
  const providerLabel = providerMeta.label;
  const isPushTarget = isPushDestinationKind(provider);
  const orgNoun = DESTINATION_PROVIDER_ORG_NOUNS[provider];

  const handleProviderChange = (value: string) => {
    const nextProvider = value as DestinationProvider;
    const newConfig: GiteaConfig = { ...config, provider: nextProvider };
    // A hosted target is prefilled with its public instance; moving away
    // from one clears that prefill so a Gitea URL is asked for again.
    const hostedDefault = DESTINATION_PROVIDER_DEFAULT_URLS[nextProvider];
    const currentUrl = (config.url || "").trim();
    if (hostedDefault && (!currentUrl || HOSTED_DEFAULT_URLS.has(currentUrl))) {
      newConfig.url = hostedDefault;
    } else if (!hostedDefault && HOSTED_DEFAULT_URLS.has(currentUrl)) {
      newConfig.url = "";
    }
    setConfig(newConfig);
    if (onAutoSave) {
      onAutoSave(newConfig, { confirmDestinationChange: destinationUnlocked });
    }
  };
  const [serverInfo, setServerInfo] = useState<GiteaServerInfo | null>(null);

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

  // Update config when strategy changes. Only the organization instance runs
  // this effect so a second (connection) instance can't double-fire autosave.
  useEffect(() => {
    if (part !== "organization") return;
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
        : value;

    const newConfig = {
      ...config,
      [name]: normalizedValue,
    };
    setConfig(newConfig);

    // Auto-save for all field changes. Once the destination was unlocked
    // through the dialog, the save carries the confirmation the API requires.
    if (onAutoSave) {
      onAutoSave(newConfig, { confirmDestinationChange: destinationUnlocked });
    }
  };

  const testConnection = async () => {
    if (!config.token || (!isPushTarget && !config.url)) {
      toast.error(`${providerLabel} URL and token are required to test the connection`);
      return;
    }

    setIsLoading(true);

    try {
      const result = await giteaApi.testConnection(config.url, config.token, {
        provider,
        username: isPushTarget ? config.username : undefined,
      });
      if (result.success) {
        setServerInfo(result.serverInfo ?? null);
        toast.success(`Successfully connected to ${providerLabel}!`);
      } else {
        setServerInfo(null);
        toast.error(
          result.message || `Failed to connect to ${providerLabel}. Please check your URL and token.`
        );
      }
    } catch (error) {
      setServerInfo(null);
      toast.error(
        error instanceof Error ? error.message : "An unknown error occurred"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const serverInfoLabel = (info: GiteaServerInfo): string => {
    if (info.type === "github" || info.type === "gitlab") {
      return `Connected to ${info.version}`;
    }
    return `${info.type === "forgejo" ? "Forgejo" : "Gitea"} ${info.version} detected`;
  };

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
              disabled={isLoading || !config.token || (!isPushTarget && !config.url)}
            >
              <PlugZap className="mr-1.5 h-3.5 w-3.5" />
              {isLoading ? "Testing..." : "Test"}
            </Button>
          </div>
        }
        footer={
          serverInfo ? (
            <StatusFooterItem icon={Info} label={serverInfoLabel(serverInfo)} />
          ) : undefined
        }
      >
        <CardSection>
          {serverInfo?.type === "forgejo" && serverInfo.hasMirrorCredBug && (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>
                Forgejo {serverInfo.version} has a known mirror-credential bug
              </AlertTitle>
              <AlertDescription>
                <p>
                  Pull-mirror credentials sent via Forgejo's migrate API aren't persisted on this version, so subsequent syncs of private repos fail with <code className="text-xs font-mono bg-amber-100 dark:bg-amber-900/40 px-1 py-0.5 rounded">terminal prompts disabled</code>. Fixed in Forgejo 15.0.0 (
                  <a
                    href="https://codeberg.org/forgejo/forgejo/pulls/11909"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    PR #11909
                  </a>
                  ).
                </p>
                <p>
                  Upgrade Forgejo to 15.0.0 or later, then delete and re-mirror affected repos — or open each repo's Settings → Mirror Settings in Forgejo and re-enter the GitHub token once.
                </p>
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label
              htmlFor="destination-provider"
              className="text-xs font-medium text-muted-foreground"
            >
              Destination
            </Label>
            <Select value={provider} onValueChange={handleProviderChange} disabled={destinationLocked}>
              <SelectTrigger id="destination-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {destinationProviders.map((option) => (
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
              {isPushTarget
                ? `${providerLabel} has no pull mirror API, so this app keeps a bare clone of each source repository and pushes its branches and tags there.`
                : "Where mirrors are created. Gitea and Forgejo share the same API."}
            </p>
            {destinationLock?.locked && (
              <HostLockNotice
                summary={`${destinationLock.mirroredCount} ${
                  destinationLock.mirroredCount === 1 ? "repository is" : "repositories are"
                } mirrored to this ${providerLabel}`}
                title="Change the destination?"
                consequences={[
                  "Existing mirrors stay on the current server and are not moved.",
                  "Syncing them from here fails until they exist on the new server or are removed and mirrored again.",
                  "New mirrors go to the new server only.",
                ]}
                changeLabel="Change destination"
                unlocked={destinationUnlocked}
                onUnlock={() => setDestinationUnlocked(true)}
              />
            )}
          </div>

          {isPushTarget && (
            <Alert>
              <UploadCloud className="h-4 w-4" />
              <AlertTitle>Push target (beta)</AlertTitle>
              <AlertDescription>
                <p>
                  Branches and tags are pushed with force and prune, so the {providerLabel} copy always matches the
                  source and is overwritten on every sync. Issues, pull requests, releases, wiki and LFS objects are
                  not mirrored. Bare clones live in the data directory next to the database.
                </p>
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label
              htmlFor="gitea-username"
              className="text-xs font-medium text-muted-foreground"
            >
              {isPushTarget ? "Account" : "Username"}
            </Label>
            <Input
              id="gitea-username"
              name="username"
              type="text"
              value={config.username}
              onChange={handleChange}
              placeholder={`Your ${providerLabel} username`}
              required
            />
            {isPushTarget && (
              <p className="text-[11px] text-muted-foreground/80">
                {`The user the token belongs to. Repositories go under this account, or under the ${orgNoun} the mirror strategy picks.`}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="gitea-url"
              className="text-xs font-medium text-muted-foreground"
            >
              {isPushTarget ? "Instance URL" : "Server URL"}
            </Label>
            <Input
              id="gitea-url"
              name="url"
              type="url"
              value={config.url}
              onChange={handleChange}
              placeholder={
                DESTINATION_PROVIDER_DEFAULT_URLS[provider] ?? `https://your-${provider}-instance.com`
              }
              disabled={destinationLocked}
              required={!isPushTarget}
            />
            {isPushTarget && (
              <p className="text-[11px] text-muted-foreground/80">
                {provider === "github"
                  ? "github.com, or the URL of your GitHub Enterprise Server"
                  : "gitlab.com, or the URL of your self hosted GitLab"}
              </p>
            )}
          </div>

          {!isPushTarget && (
            <div className="space-y-1.5">
              <Label
                htmlFor="gitea-external-url"
                className="text-xs font-medium text-muted-foreground"
              >
                External URL (optional)
              </Label>
              <Input
                id="gitea-external-url"
                name="externalUrl"
                type="url"
                value={config.externalUrl || ""}
                onChange={handleChange}
                placeholder="https://gitea.example.com"
              />
              <p className="text-[11px] text-muted-foreground/80">
                Dashboard links only, syncing always uses the server URL
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label
              htmlFor="gitea-token"
              className="text-xs font-medium text-muted-foreground"
            >
              Access token
            </Label>
            <Input
              id="gitea-token"
              name="token"
              type="password"
              value={config.token}
              onChange={handleChange}
              placeholder={`Your ${providerLabel} access token`}
              required
            />
            <p className="text-[11px] text-muted-foreground/80">
              {isPushTarget
                ? `A personal access token with the scopes ${PUSH_DESTINATION_TOKEN_SCOPES[provider].join(", ")}. ${
                    provider === "github"
                      ? "GitHub rejects pushes that add workflow files unless the token has the workflow scope."
                      : "Groups the token cannot see are created as new top level groups."
                  }`
                : `Create one in ${providerLabel} under Settings → Applications`}
            </p>
          </div>
        </CardSection>
      </SettingsCard>
    );
  }

  return (
    <>
      {/* Organization Structure */}
      <SettingsCard
        icon={Building2}
        title="Organization Structure"
        footer={
          <StatusFooterItem
            icon={Info}
            label="Strategy applies to newly mirrored repositories"
          />
        }
      >
        <CardSection>
          <OrganizationStrategy
            strategy={mirrorStrategy}
            destinationOrg={config.organization}
            starredReposOrg={config.starredReposOrg}
            starredReposMode={config.starredReposMode}
            onStrategyChange={setMirrorStrategy}
            githubUsername={githubUsername}
            giteaUsername={config.username}
          />
        </CardSection>
        <CardDivider />
        <CardSection>
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
        </CardSection>
      </SettingsCard>
    </>
  );
}
