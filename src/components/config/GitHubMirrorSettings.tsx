import React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Info,
  Check,
  GitBranch,
  Star,
  Lock,
  Archive,
  GitPullRequest,
  Tag,
  FileText,
  MessageSquare,
  Target,
  BookOpen,
  GitFork,
  ChevronDown,
  Building,
  HardDrive,
  FileCode2,
  Plus,
  Users,
  UserX,
  X
} from "lucide-react";
import type { GitHubConfig, MirrorOptions, AdvancedOptions, DuplicateNameStrategy } from "@/types/config";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { githubApi } from "@/lib/api";
import {
  SOURCE_PROVIDER_LABELS,
  SOURCE_PROVIDER_ORG_NOUNS,
} from "@/lib/source-providers/kinds";
import {
  SettingsCard,
  SectionTitle,
  SwitchRow,
  OptionRow,
  StatusFooterItem,
  CardDivider,
  CardSection,
} from "./settings-ui";

interface GitHubMirrorSettingsProps {
  githubConfig: GitHubConfig;
  mirrorOptions: MirrorOptions;
  advancedOptions: AdvancedOptions;
  onGitHubConfigChange: (config: GitHubConfig) => void;
  onMirrorOptionsChange: (options: MirrorOptions) => void;
  onAdvancedOptionsChange: (options: AdvancedOptions) => void;
  /** Which card to render; defaults to both. */
  part?: "selection" | "content" | "both";
}

export function GitHubMirrorSettings({
  githubConfig,
  mirrorOptions,
  advancedOptions,
  onGitHubConfigChange,
  onMirrorOptionsChange,
  onAdvancedOptionsChange,
  part = "both",
}: GitHubMirrorSettingsProps) {
  // Star lists, issues, pull requests, releases, labels and milestones all
  // read the GitHub API, so they are only offered for GitHub sources.
  const sourceProvider = githubConfig.provider ?? "github";
  const isGithubSource = sourceProvider === "github";
  const sourceLabel = SOURCE_PROVIDER_LABELS[sourceProvider];
  const orgNoun = SOURCE_PROVIDER_ORG_NOUNS[sourceProvider];
  const [starListsOpen, setStarListsOpen] = React.useState(false);
  const [starListSearch, setStarListSearch] = React.useState("");
  const [customStarListName, setCustomStarListName] = React.useState("");
  const [customOrgName, setCustomOrgName] = React.useState("");
  const [availableStarLists, setAvailableStarLists] = React.useState<string[]>([]);
  const [loadingStarLists, setLoadingStarLists] = React.useState(false);
  const [loadedStarLists, setLoadedStarLists] = React.useState(false);
  const [attemptedStarListLoad, setAttemptedStarListLoad] = React.useState(false);

  const normalizeStarListNames = React.useCallback((lists: string[] | undefined): string[] => {
    if (!Array.isArray(lists)) return [];

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const list of lists) {
      const trimmed = list.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(trimmed);
    }

    return normalized;
  }, []);

  const selectedStarLists = React.useMemo(
    () => normalizeStarListNames(githubConfig.starredLists),
    [githubConfig.starredLists, normalizeStarListNames],
  );

  const allKnownStarLists = React.useMemo(
    () => normalizeStarListNames([...availableStarLists, ...selectedStarLists]),
    [availableStarLists, selectedStarLists, normalizeStarListNames],
  );

  const handleGitHubChange = (field: keyof GitHubConfig, value: boolean | string | string[]) => {
    onGitHubConfigChange({ ...githubConfig, [field]: value });
  };

  const handleMirrorChange = (field: keyof MirrorOptions, value: boolean | number | null) => {
    onMirrorOptionsChange({ ...mirrorOptions, [field]: value });
  };

  const handleMetadataComponentChange = (component: keyof MirrorOptions['metadataComponents'], value: boolean) => {
    onMirrorOptionsChange({
      ...mirrorOptions,
      metadataComponents: {
        ...mirrorOptions.metadataComponents,
        [component]: value,
      },
    });
  };

  const handleAdvancedChange = (field: keyof AdvancedOptions, value: boolean) => {
    onAdvancedOptionsChange({ ...advancedOptions, [field]: value });
  };

  const setSelectedStarLists = React.useCallback((lists: string[]) => {
    onGitHubConfigChange({
      ...githubConfig,
      starredLists: normalizeStarListNames(lists),
    });
  }, [githubConfig, normalizeStarListNames, onGitHubConfigChange]);

  const includedOrgs = React.useMemo(
    () => githubConfig.includeOrganizations ?? [],
    [githubConfig.includeOrganizations],
  );

  const addIncludedOrg = React.useCallback(() => {
    const trimmed = customOrgName.trim();
    if (!trimmed) return;
    const exists = includedOrgs.some(
      (org) => org.toLowerCase() === trimmed.toLowerCase(),
    );
    if (!exists) {
      onGitHubConfigChange({
        ...githubConfig,
        includeOrganizations: [...includedOrgs, trimmed],
      });
    }
    setCustomOrgName("");
  }, [customOrgName, includedOrgs, githubConfig, onGitHubConfigChange]);

  const removeIncludedOrg = React.useCallback(
    (name: string) => {
      onGitHubConfigChange({
        ...githubConfig,
        includeOrganizations: includedOrgs.filter(
          (org) => org.toLowerCase() !== name.toLowerCase(),
        ),
      });
    },
    [includedOrgs, githubConfig, onGitHubConfigChange],
  );

  const loadStarLists = React.useCallback(async () => {
    if (
      loadingStarLists ||
      loadedStarLists ||
      attemptedStarListLoad ||
      !githubConfig.mirrorStarred
    ) return;

    setAttemptedStarListLoad(true);
    setLoadingStarLists(true);
    try {
      const response = await githubApi.getStarredLists();
      setAvailableStarLists(normalizeStarListNames(response.lists));
      setLoadedStarLists(true);
    } catch {
      // Keep UX usable with manual custom input even if list fetch fails.
      // Allow retry on next popover open.
      setLoadedStarLists(false);
    } finally {
      setLoadingStarLists(false);
    }
  }, [
    attemptedStarListLoad,
    githubConfig.mirrorStarred,
    loadedStarLists,
    loadingStarLists,
    normalizeStarListNames,
  ]);

  React.useEffect(() => {
    if (!starListsOpen || !githubConfig.mirrorStarred) return;
    void loadStarLists();
  }, [starListsOpen, githubConfig.mirrorStarred, loadStarLists]);

  React.useEffect(() => {
    if (!githubConfig.mirrorStarred) {
      setStarListsOpen(false);
    }
  }, [githubConfig.mirrorStarred]);

  React.useEffect(() => {
    if (!starListsOpen) {
      setAttemptedStarListLoad(false);
    }
  }, [starListsOpen]);

  // Calculate what content is included for starred repos
  const starredRepoContent = {
    code: true, // Always included
    releases: !advancedOptions.starredCodeOnly && mirrorOptions.mirrorReleases,
    issues: !advancedOptions.starredCodeOnly && mirrorOptions.mirrorMetadata && mirrorOptions.metadataComponents.issues,
    pullRequests: !advancedOptions.starredCodeOnly && mirrorOptions.mirrorMetadata && mirrorOptions.metadataComponents.pullRequests,
    wiki: !advancedOptions.starredCodeOnly && mirrorOptions.mirrorMetadata && mirrorOptions.metadataComponents.wiki,
  };

  const starredContentCount = Object.entries(starredRepoContent).filter(([key, value]) => key !== 'code' && value).length;
  const totalStarredOptions = 4; // releases, issues, PRs, wiki

  const normalizedStarListSearch = starListSearch.trim();
  const canAddSearchAsStarList = normalizedStarListSearch.length > 0
    && !allKnownStarLists.some((list) => list.toLowerCase() === normalizedStarListSearch.toLowerCase());

  const addCustomStarList = () => {
    const trimmed = customStarListName.trim();
    if (!trimmed) return;
    setSelectedStarLists([...selectedStarLists, trimmed]);
    setCustomStarListName("");
  };

  const starredContentPopover = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={!githubConfig.mirrorStarred}
          className="h-8 min-w-[140px] justify-between text-xs font-normal"
        >
          <span>
            {advancedOptions.starredCodeOnly ? (
              "Code only"
            ) : starredContentCount === 0 ? (
              "Code only"
            ) : starredContentCount === totalStarredOptions ? (
              "Full content"
            ) : (
              `${starredContentCount + 1} of ${totalStarredOptions + 1} selected`
            )}
          </span>
          <ChevronDown className="ml-2 h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Starred repos content</div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs">
                  <p className="text-xs">
                    Choose what content to mirror from starred repositories.
                    Selecting "Lightweight mode" will only mirror code for better performance.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <Separator className="my-2" />

          <div className="space-y-3">
            <div className="flex items-center space-x-3 py-1 px-1 rounded hover:bg-accent">
              <Checkbox
                id="starred-lightweight"
                checked={advancedOptions.starredCodeOnly}
                onCheckedChange={(checked) => handleAdvancedChange('starredCodeOnly', !!checked)}
              />
              <Label
                htmlFor="starred-lightweight"
                className="text-sm font-normal cursor-pointer flex-1"
              >
                <div className="space-y-0.5">
                  <div className="font-medium">Lightweight mode</div>
                  <div className="text-xs text-muted-foreground">
                    Only mirror code, skip all metadata
                  </div>
                </div>
              </Label>
            </div>

            {!advancedOptions.starredCodeOnly && (
              <>
                <Separator className="my-2" />
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Content included for starred repos:
                  </p>

                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-xs pl-2">
                      <GitBranch className="h-3 w-3 text-muted-foreground" />
                      <span>Source code</span>
                      <Badge variant="secondary" className="ml-auto text-[10px] px-2 h-4">Always</Badge>
                    </div>

                    <div className={cn(
                      "flex items-center gap-2 text-xs pl-2",
                      starredRepoContent.releases ? "" : "opacity-50"
                    )}>
                      <Tag className="h-3 w-3 text-muted-foreground" />
                      <span>Releases & Tags</span>
                      {starredRepoContent.releases && <Badge variant="outline" className="ml-auto text-[10px] px-2 h-4">Included</Badge>}
                    </div>

                    <div className={cn(
                      "flex items-center gap-2 text-xs pl-2",
                      starredRepoContent.issues ? "" : "opacity-50"
                    )}>
                      <MessageSquare className="h-3 w-3 text-muted-foreground" />
                      <span>Issues</span>
                      {starredRepoContent.issues && <Badge variant="outline" className="ml-auto text-[10px] px-2 h-4">Included</Badge>}
                    </div>

                    <div className={cn(
                      "flex items-center gap-2 text-xs pl-2",
                      starredRepoContent.pullRequests ? "" : "opacity-50"
                    )}>
                      <GitPullRequest className="h-3 w-3 text-muted-foreground" />
                      <span>Pull Requests</span>
                      {starredRepoContent.pullRequests && <Badge variant="outline" className="ml-auto text-[10px] px-2 h-4">Included</Badge>}
                    </div>

                    <div className={cn(
                      "flex items-center gap-2 text-xs pl-2",
                      starredRepoContent.wiki ? "" : "opacity-50"
                    )}>
                      <BookOpen className="h-3 w-3 text-muted-foreground" />
                      <span>Wiki</span>
                      {starredRepoContent.wiki && <Badge variant="outline" className="ml-auto text-[10px] px-2 h-4">Included</Badge>}
                    </div>
                  </div>

                  <p className="text-[10px] text-muted-foreground mt-2">
                    To include more content, enable them in the Mirror Content card
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );

  const metadataPopover = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={!mirrorOptions.mirrorMetadata}
          className="h-8 min-w-[140px] justify-between text-xs font-normal"
        >
          <span>
            {(() => {
              const selectedCount = Object.values(mirrorOptions.metadataComponents).filter(Boolean).length;
              const totalCount = Object.keys(mirrorOptions.metadataComponents).length;
              if (selectedCount === 0) return "No items selected";
              if (selectedCount === totalCount) return "All items selected";
              return `${selectedCount} of ${totalCount} selected`;
            })()}
          </span>
          <ChevronDown className="ml-2 h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Metadata to mirror</div>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs font-normal text-primary hover:text-primary/80"
              disabled={!isGithubSource}
              onClick={() => {
                const allSelected = Object.values(mirrorOptions.metadataComponents).every(Boolean);
                const newValue = !allSelected;

                // Update all metadata components at once
                onMirrorOptionsChange({
                  ...mirrorOptions,
                  metadataComponents: {
                    issues: newValue,
                    pullRequests: newValue,
                    labels: newValue,
                    milestones: newValue,
                    wiki: newValue,
                  },
                });
              }}
            >
              {Object.values(mirrorOptions.metadataComponents).every(Boolean) ? 'Deselect all' : 'Select all'}
            </Button>
          </div>

          <Separator className="my-2" />

          <div className="space-y-2">
            <div className="flex items-center space-x-3 py-1 px-1 rounded hover:bg-accent">
              <Checkbox
                id="metadata-issues-popup"
                disabled={!isGithubSource}
                checked={mirrorOptions.metadataComponents.issues}
                onCheckedChange={(checked) => handleMetadataComponentChange('issues', !!checked)}
              />
              <Label
                htmlFor="metadata-issues-popup"
                className="text-sm font-normal cursor-pointer flex items-center gap-2 flex-1"
              >
                <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                Issues
              </Label>
            </div>

            <div className="flex items-center space-x-3 py-1 px-1 rounded hover:bg-accent">
              <Checkbox
                id="metadata-prs-popup"
                disabled={!isGithubSource}
                checked={mirrorOptions.metadataComponents.pullRequests}
                onCheckedChange={(checked) => handleMetadataComponentChange('pullRequests', !!checked)}
              />
              <Label
                htmlFor="metadata-prs-popup"
                className="text-sm font-normal cursor-pointer flex items-center gap-2 flex-1"
              >
                <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" />
                Pull Requests
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-sm">
                      <div className="space-y-2">
                        <p className="font-semibold">Pull Requests are mirrored as issues</p>
                        <p className="text-xs">
                          Due to Gitea API limitations, PRs cannot be created as actual pull requests.
                          Instead, they are mirrored as issues with:
                        </p>
                        <ul className="text-xs space-y-1 ml-3">
                          <li>• [PR #number] prefix in title</li>
                          <li>• Full PR description and metadata</li>
                          <li>• Commit history (up to 10 commits)</li>
                          <li>• File changes summary</li>
                          <li>• Diff preview (first 5 files)</li>
                          <li>• Review comments preserved</li>
                          <li>• Merge/close status tracking</li>
                        </ul>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
            </div>

            <div className="flex items-center space-x-3 py-1 px-1 rounded hover:bg-accent">
              <Checkbox
                id="metadata-labels-popup"
                disabled={!isGithubSource}
                checked={mirrorOptions.metadataComponents.labels}
                onCheckedChange={(checked) => handleMetadataComponentChange('labels', !!checked)}
              />
              <Label
                htmlFor="metadata-labels-popup"
                className="text-sm font-normal cursor-pointer flex items-center gap-2 flex-1"
              >
                <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                Labels
              </Label>
            </div>

            <div className="flex items-center space-x-3 py-1 px-1 rounded hover:bg-accent">
              <Checkbox
                id="metadata-milestones-popup"
                disabled={!isGithubSource}
                checked={mirrorOptions.metadataComponents.milestones}
                onCheckedChange={(checked) => handleMetadataComponentChange('milestones', !!checked)}
              />
              <Label
                htmlFor="metadata-milestones-popup"
                className="text-sm font-normal cursor-pointer flex items-center gap-2 flex-1"
              >
                <Target className="h-3.5 w-3.5 text-muted-foreground" />
                Milestones
              </Label>
            </div>

            <div className="flex items-center space-x-3 py-1 px-1 rounded hover:bg-accent">
              <Checkbox
                id="metadata-wiki-popup"
                checked={mirrorOptions.metadataComponents.wiki}
                onCheckedChange={(checked) => handleMetadataComponentChange('wiki', !!checked)}
              />
              <Label
                htmlFor="metadata-wiki-popup"
                className="text-sm font-normal cursor-pointer flex items-center gap-2 flex-1"
              >
                <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                Wiki
              </Label>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );

  return (
    <>
      {/* Repository Selection */}
      {part !== "content" && (
      <SettingsCard
        icon={GitBranch}
        title="Repository Selection"
        footer={
          <StatusFooterItem
            icon={Info}
            label="Changes apply on the next sync or repository discovery"
          />
        }
      >
        <CardSection>
          <SectionTitle>Repositories to mirror</SectionTitle>

          <SwitchRow
            icon={Lock}
            label="Private repositories"
            description="Mirror your private repositories"
            checked={githubConfig.privateRepositories}
            onCheckedChange={(checked) => handleGitHubChange('privateRepositories', checked)}
          />

          <SwitchRow
            icon={Users}
            label="Collaborator repositories"
            description="Repos where you collaborate but are not the owner"
            checked={githubConfig.includeCollaboratorRepos ?? true}
            onCheckedChange={(checked) => handleGitHubChange('includeCollaboratorRepos', checked)}
          />

          <SwitchRow
            icon={Star}
            label="Starred repositories"
            description={`Include repositories you've starred on ${sourceLabel}`}
            checked={githubConfig.mirrorStarred}
            onCheckedChange={(checked) => handleGitHubChange('mirrorStarred', checked)}
          />

          {githubConfig.mirrorStarred && (
            <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
              <SwitchRow
                label="Auto-mirror new starred repositories"
                description="Off means starred repos are imported for browsing only"
                info="When disabled, starred repos wait for a manual mirror click. You can still mirror individual repos manually."
                checked={advancedOptions.autoMirrorStarred ?? false}
                onCheckedChange={(checked) => handleAdvancedChange('autoMirrorStarred', checked)}
              />

              <OptionRow
                label="Starred repos content"
                description="Full content or lightweight code-only mirroring"
                right={starredContentPopover}
              />

              {isGithubSource && (
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground">
                  Star lists (optional)
                </Label>
                <Popover open={starListsOpen} onOpenChange={setStarListsOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={starListsOpen}
                      className="w-full justify-between h-9 text-xs font-normal"
                    >
                      <span className="truncate text-left">
                        {selectedStarLists.length === 0
                          ? "All starred repositories"
                          : `${selectedStarLists.length} list${selectedStarLists.length === 1 ? "" : "s"} selected`}
                      </span>
                      <ChevronDown className="ml-2 h-3 w-3 opacity-50 shrink-0" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[360px] p-0" align="start">
                    <Command>
                      <CommandInput
                        value={starListSearch}
                        onValueChange={setStarListSearch}
                        placeholder="Search GitHub star lists..."
                      />
                      <CommandList>
                        <CommandEmpty>
                          {loadingStarLists ? "Loading star lists..." : "No matching lists"}
                        </CommandEmpty>
                        <CommandGroup>
                          {allKnownStarLists.map((list) => {
                            const isSelected = selectedStarLists.some(
                              (selected) => selected.toLowerCase() === list.toLowerCase(),
                            );

                            return (
                              <CommandItem
                                key={list}
                                value={list}
                                onSelect={() => {
                                  if (isSelected) {
                                    setSelectedStarLists(
                                      selectedStarLists.filter(
                                        (selected) => selected.toLowerCase() !== list.toLowerCase(),
                                      ),
                                    );
                                  } else {
                                    setSelectedStarLists([...selectedStarLists, list]);
                                  }
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    isSelected ? "opacity-100" : "opacity-0",
                                  )}
                                />
                                <span className="truncate">{list}</span>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      </CommandList>
                    </Command>

                    {canAddSearchAsStarList && (
                      <div className="border-t p-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-xs"
                          onClick={() => {
                            setSelectedStarLists([...selectedStarLists, normalizedStarListSearch]);
                            setStarListSearch("");
                          }}
                        >
                          <Plus className="mr-2 h-3.5 w-3.5" />
                          Add "{normalizedStarListSearch}"
                        </Button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>

                <p className="text-[11px] text-muted-foreground/80">
                  Leave empty to mirror all starred repositories
                </p>

                {selectedStarLists.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedStarLists.map((list) => (
                      <Badge key={list} variant="secondary" className="gap-1">
                        <span>{list}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedStarLists(
                              selectedStarLists.filter(
                                (selected) => selected.toLowerCase() !== list.toLowerCase(),
                              ),
                            )
                          }
                          className="rounded-sm hover:text-foreground/80"
                          aria-label={`Remove ${list} list`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Input
                    value={customStarListName}
                    onChange={(event) => setCustomStarListName(event.target.value)}
                    placeholder="Add custom list name"
                    className="h-8 text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={addCustomStarList}
                    disabled={!customStarListName.trim()}
                  >
                    Add
                  </Button>
                </div>
              </div>
              )}

              <OptionRow
                icon={FileCode2}
                label="Name collision strategy"
                description="For repos with the same name from different owners"
                right={
                  <Select
                    value={githubConfig.starredDuplicateStrategy || "suffix"}
                    onValueChange={(value) => handleGitHubChange('starredDuplicateStrategy', value as DuplicateNameStrategy)}
                  >
                    <SelectTrigger className="w-[150px] h-8 text-xs">
                      <SelectValue placeholder="Select strategy" />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="suffix" className="text-xs">
                        <span className="font-mono">repo-owner</span>
                      </SelectItem>
                      <SelectItem value="prefix" className="text-xs">
                        <span className="font-mono">owner-repo</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
            </div>
          )}
        </CardSection>

        <CardDivider />

        <CardSection>
          <SectionTitle>Filtering</SectionTitle>

          <SwitchRow
            icon={GitFork}
            label="Skip forked repositories"
            description="Exclude repositories that are forks of other projects"
            checked={advancedOptions.skipForks}
            onCheckedChange={(checked) => handleAdvancedChange('skipForks', checked)}
          />

          <SwitchRow
            icon={UserX}
            label="Skip personal repositories"
            description={`Only mirror repos belonging to ${orgNoun}s`}
            checked={advancedOptions.skipPersonalRepos ?? false}
            onCheckedChange={(checked) => handleAdvancedChange('skipPersonalRepos', checked)}
          />

          <div className="space-y-2">
            <OptionRow
              icon={Building}
              label={`Limit to specific ${orgNoun}s`}
              description={`Empty mirrors every ${orgNoun} you belong to`}
            />

            {includedOrgs.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {includedOrgs.map((org) => (
                  <Badge key={org} variant="secondary" className="gap-1">
                    <span>{org}</span>
                    <button
                      type="button"
                      onClick={() => removeIncludedOrg(org)}
                      className="rounded-sm hover:text-foreground/80"
                      aria-label={`Remove ${org} organization`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Input
                value={customOrgName}
                onChange={(event) => setCustomOrgName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addIncludedOrg();
                  }
                }}
                placeholder={`Add ${orgNoun} name`}
                className="h-8 text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={addIncludedOrg}
                disabled={!customOrgName.trim()}
              >
                Add
              </Button>
            </div>
          </div>
        </CardSection>
      </SettingsCard>
      )}

      {/* Mirror Content */}
      {part !== "selection" && (
      <SettingsCard
        icon={Archive}
        title="Mirror Content"
        footer={
          <StatusFooterItem
            icon={Info}
            label={
              isGithubSource
                ? "Pull requests are mirrored as issues due to Gitea API limits"
                : "Issues, pull requests and releases are mirrored for GitHub sources only"
            }
          />
        }
      >
        <CardSection>
          <SectionTitle>Content & data</SectionTitle>

          <OptionRow
            icon={GitBranch}
            label="Source code & branches"
            description="Always included in every mirror"
            right={
              <span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
                ALWAYS
              </span>
            }
          />

          <SwitchRow
            icon={Tag}
            label="Releases & tags"
            description={
              !isGithubSource
                ? "Release assets need a GitHub source. Tags always come with the code"
                : mirrorOptions.mirrorReleases
                  ? "Includes tags. Leave the assets box empty to upload assets for every mirrored release, or set it to 0 for release notes only"
                  : "Includes release assets and tags"
            }
            disabled={!isGithubSource}
            checked={mirrorOptions.mirrorReleases}
            onCheckedChange={(checked) => handleMirrorChange('mirrorReleases', checked)}
            extra={
              mirrorOptions.mirrorReleases ? (
                <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <label htmlFor="release-limit">Latest</label>
                    <input
                      id="release-limit"
                      type="number"
                      min="1"
                      value={mirrorOptions.releaseLimit || 10}
                      onChange={(e) => {
                        const value = parseInt(e.target.value) || 10;
                        const clampedValue = Math.max(1, value);
                        handleMirrorChange('releaseLimit', clampedValue);
                      }}
                      className="w-16 rounded border border-input bg-background px-2 py-1 text-xs text-foreground"
                    />
                  </div>
                  {/* Empty means every mirrored release gets its assets (the
                      behaviour before #311); 0 means notes only. */}
                  <div className="flex items-center gap-1.5">
                    <label htmlFor="release-asset-limit">Assets for latest</label>
                    <input
                      id="release-asset-limit"
                      type="number"
                      min="0"
                      placeholder="all"
                      title="Leave empty to upload assets for every mirrored release, or 0 for none"
                      value={mirrorOptions.releaseAssetLimit ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (raw === '') {
                          handleMirrorChange('releaseAssetLimit', null);
                          return;
                        }
                        const value = parseInt(raw, 10);
                        handleMirrorChange(
                          'releaseAssetLimit',
                          Number.isFinite(value) ? Math.max(0, value) : null
                        );
                      }}
                      className="w-16 rounded border border-input bg-background px-2 py-1 text-xs text-foreground"
                    />
                  </div>
                </div>
              ) : undefined
            }
          />

          <SwitchRow
            icon={HardDrive}
            label="Git LFS objects"
            description="Requires LFS enabled on your Gitea server and Git v2.1.2+"
            badge="BETA"
            checked={mirrorOptions.mirrorLFS}
            onCheckedChange={(checked) => handleMirrorChange('mirrorLFS', checked)}
          />

          <SwitchRow
            icon={FileText}
            label="Repository metadata"
            description={
              isGithubSource
                ? "Issues, pull requests, labels, milestones and wiki"
                : "Wiki only. Issues, pull requests, labels and milestones need a GitHub source"
            }
            checked={mirrorOptions.mirrorMetadata}
            onCheckedChange={(checked) => handleMirrorChange('mirrorMetadata', checked)}
            extra={mirrorOptions.mirrorMetadata ? metadataPopover : undefined}
          />
        </CardSection>
      </SettingsCard>
      )}
    </>
  );
}
