import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { AdvancedOptions, GiteaConfig, GitHubConfig, MirrorOptions } from "@/types/config";
import type { MirrorPairOptions, Server } from "@/lib/db/schema";
import { GitHubConfigForm } from "@/components/config/GitHubConfigForm";
import { GitHubMirrorSettings } from "@/components/config/GitHubMirrorSettings";
import { GiteaConfigForm } from "@/components/config/GiteaConfigForm";

export const DEFAULT_PAIR_OPTIONS: MirrorPairOptions = {
  repositorySelection: { mode: "all", selectedRepos: [], includePatterns: [], excludePatterns: [], includeForks: false, includeArchived: false, includePrivate: true, privateRepositories: true, includeCollaboratorRepos: true, includeOrganizations: [], mirrorStarred: false, starredLists: [], starredDuplicateStrategy: "suffix", starredReposMode: "dedicated-org", skipForks: false, starredCodeOnly: false, autoMirrorStarred: false, skipPersonalRepos: false },
  organizationStructure: { strategy: "preserve", starredReposOrg: "starred", starredReposMode: "dedicated-org", visibility: "public", preserveOrgStructure: true },
  destructiveProtection: { detectForcePush: true, backupStrategy: "on-force-push", backupRetentionCount: 5, backupRetentionDays: 30, backupDirectory: "data/repo-backups", blockSyncOnBackupFailure: false },
  mirrorContent: { releases: false, lfs: false, issues: false, pullRequests: false, labels: false, milestones: false, wiki: false, mirrorReleases: false, releaseLimit: 10, mirrorLFS: false, mirrorMetadata: false, metadataComponents: { issues: false, pullRequests: false, labels: false, milestones: false, wiki: false } },
};

function DisabledCards({ disabled, children }: { disabled: boolean; children: ReactNode }) { return <fieldset disabled={disabled} aria-disabled={disabled} className={disabled ? "m-0 min-w-0 border-0 p-0 opacity-45" : "m-0 min-w-0 border-0 p-0"}>{children}</fieldset>; }

interface PairOptionCardsProps { options: MirrorPairOptions; onChange: (options: MirrorPairOptions) => void; sourceServer?: Server; targetServer?: Server; disabled?: boolean; column?: "left" | "right"; }

export function PairOptionCards({ options, onChange, sourceServer, targetServer, disabled = false, column }: PairOptionCardsProps) {
  const selection = options.repositorySelection; const organization = options.organizationStructure; const protection = options.destructiveProtection; const content = options.mirrorContent;
  const update = <K extends keyof MirrorPairOptions>(key: K, value: MirrorPairOptions[K]) => onChange({ ...options, [key]: value });
  const githubConfig: GitHubConfig = { username: sourceServer?.username ?? "", token: "", privateRepositories: selection.privateRepositories, includeCollaboratorRepos: selection.includeCollaboratorRepos, includeOrganizations: selection.includeOrganizations, mirrorStarred: selection.mirrorStarred, starredLists: selection.starredLists, starredDuplicateStrategy: selection.starredDuplicateStrategy, starredReposMode: selection.starredReposMode };
  const mirrorOptions: MirrorOptions = { mirrorReleases: content.mirrorReleases, releaseLimit: content.releaseLimit, mirrorLFS: content.mirrorLFS, mirrorMetadata: content.mirrorMetadata, metadataComponents: content.metadataComponents };
  const advancedOptions: AdvancedOptions = { skipForks: selection.skipForks, starredCodeOnly: selection.starredCodeOnly, autoMirrorStarred: selection.autoMirrorStarred, skipPersonalRepos: selection.skipPersonalRepos };
  const giteaConfig: GiteaConfig = { url: targetServer?.url ?? "", username: targetServer?.username ?? "", token: "", organization: organization.singleOrg ?? "", visibility: organization.visibility, starredReposOrg: organization.starredReposOrg, starredReposMode: organization.starredReposMode, preserveOrgStructure: organization.preserveOrgStructure, mirrorStrategy: organization.strategy, personalReposOrg: organization.personalReposOrg, backupStrategy: protection.backupStrategy, backupRetentionCount: protection.backupRetentionCount, backupRetentionDays: protection.backupRetentionDays, backupDirectory: protection.backupDirectory, blockSyncOnBackupFailure: protection.blockSyncOnBackupFailure };
  const setGitHubConfig: Dispatch<SetStateAction<GitHubConfig>> = (next) => { const value = typeof next === "function" ? next(githubConfig) : next; update("repositorySelection", { ...selection, privateRepositories: value.privateRepositories, includePrivate: value.privateRepositories, includeCollaboratorRepos: value.includeCollaboratorRepos ?? true, includeOrganizations: value.includeOrganizations ?? [], mirrorStarred: value.mirrorStarred, starredLists: value.starredLists ?? [], starredDuplicateStrategy: value.starredDuplicateStrategy ?? "suffix", starredReposMode: value.starredReposMode ?? "dedicated-org" }); };
  const setMirrorOptions: Dispatch<SetStateAction<MirrorOptions>> = (next) => { const value = typeof next === "function" ? next(mirrorOptions) : next; update("mirrorContent", { ...content, ...value, releases: value.mirrorReleases, lfs: value.mirrorLFS, issues: value.metadataComponents.issues, pullRequests: value.metadataComponents.pullRequests, labels: value.metadataComponents.labels, milestones: value.metadataComponents.milestones, wiki: value.metadataComponents.wiki }); };
  const setAdvancedOptions: Dispatch<SetStateAction<AdvancedOptions>> = (next) => { const value = typeof next === "function" ? next(advancedOptions) : next; update("repositorySelection", { ...selection, ...value, includeForks: !value.skipForks }); };
  const setGiteaConfig: Dispatch<SetStateAction<GiteaConfig>> = (next) => { const value = typeof next === "function" ? next(giteaConfig) : next; onChange({ ...options, organizationStructure: { ...organization, strategy: value.mirrorStrategy ?? organization.strategy, singleOrg: value.organization, visibility: value.visibility, starredReposOrg: value.starredReposOrg, starredReposMode: value.starredReposMode ?? "dedicated-org", personalReposOrg: value.personalReposOrg, preserveOrgStructure: value.preserveOrgStructure }, destructiveProtection: { ...protection, backupStrategy: value.backupStrategy ?? protection.backupStrategy, backupRetentionCount: value.backupRetentionCount ?? protection.backupRetentionCount, backupRetentionDays: value.backupRetentionDays ?? protection.backupRetentionDays, backupDirectory: value.backupDirectory ?? protection.backupDirectory, blockSyncOnBackupFailure: Boolean(value.blockSyncOnBackupFailure), detectForcePush: true } }); };
  const repositoryAndProtection = <DisabledCards disabled={disabled}>
    <GitHubConfigForm part="settings" config={githubConfig} setConfig={setGitHubConfig} mirrorOptions={mirrorOptions} setMirrorOptions={setMirrorOptions} advancedOptions={advancedOptions} setAdvancedOptions={setAdvancedOptions} giteaConfig={giteaConfig} setGiteaConfig={setGiteaConfig} />
  </DisabledCards>;
  const organizationAndContent = <><DisabledCards disabled={disabled}>
    <GiteaConfigForm part="organization" config={giteaConfig} setConfig={setGiteaConfig} githubUsername={sourceServer?.username} alwaysShowDestinationOrg />
  </DisabledCards><DisabledCards disabled={disabled}>
    <GitHubMirrorSettings part="content" githubConfig={githubConfig} mirrorOptions={mirrorOptions} advancedOptions={advancedOptions} onGitHubConfigChange={setGitHubConfig} onMirrorOptionsChange={setMirrorOptions} onAdvancedOptionsChange={setAdvancedOptions} />
  </DisabledCards></>;

  if (column === "left") return repositoryAndProtection;
  if (column === "right") return <div className="flex flex-col gap-6">{organizationAndContent}</div>;
  return <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2"><div>{repositoryAndProtection}</div><div className="flex flex-col gap-6">{organizationAndContent}</div></div>;
}
