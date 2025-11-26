import React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Funnel,
  HardDrive,
  FileCode2
} from "lucide-react";
import type { GitHubConfig, MirrorOptions, AdvancedOptions, DuplicateNameStrategy } from "@/types/config";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface GitHubMirrorSettingsProps {
  githubConfig: GitHubConfig;
  mirrorOptions: MirrorOptions;
  advancedOptions: AdvancedOptions;
  onGitHubConfigChange: (config: GitHubConfig) => void;
  onMirrorOptionsChange: (options: MirrorOptions) => void;
  onAdvancedOptionsChange: (options: AdvancedOptions) => void;
}

export function GitHubMirrorSettings({
  githubConfig,
  mirrorOptions,
  advancedOptions,
  onGitHubConfigChange,
  onMirrorOptionsChange,
  onAdvancedOptionsChange,
}: GitHubMirrorSettingsProps) {
  
  const handleGitHubChange = (field: keyof GitHubConfig, value: boolean | string) => {
    onGitHubConfigChange({ ...githubConfig, [field]: value });
  };

  const handleMirrorChange = (field: keyof MirrorOptions, value: boolean | number) => {
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

  // When metadata is disabled, all components should be disabled
  const isMetadataEnabled = mirrorOptions.mirrorMetadata;
  
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

  return (
    <div className="space-y-6">
      {/* Repository Selection Section */}
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Repository Selection
          </h4>
          <p className="text-xs text-muted-foreground mb-4">
            Choose which repositories to include in mirroring
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="private-repos"
              checked={githubConfig.privateRepositories}
              onCheckedChange={(checked) => handleGitHubChange('privateRepositories', !!checked)}
            />
            <div className="space-y-0.5 flex-1">
              <Label
                htmlFor="private-repos"
                className="text-sm font-normal cursor-pointer flex items-center gap-2"
              >
                <Lock className="h-3.5 w-3.5" />
                Include personal repositories
              </Label>
              <p className="text-xs text-muted-foreground">
                Mirror your personal repositories
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-start space-x-3">
              <Checkbox
                id="starred-repos"
                checked={githubConfig.mirrorStarred}
                onCheckedChange={(checked) => handleGitHubChange('mirrorStarred', !!checked)}
              />
              <div className="space-y-0.5 flex-1">
                <Label
                  htmlFor="starred-repos"
                  className="text-sm font-normal cursor-pointer flex items-center gap-2"
                >
                  <Star className="h-3.5 w-3.5" />
                  Mirror starred repositories
                </Label>
                <p className="text-xs text-muted-foreground">
                  Include repositories you've starred on GitHub
                </p>
              </div>
            </div>

            {/* Starred repos content selection - responsive layout */}
            <div className={cn(
              "flex items-center justify-end transition-opacity duration-200 mt-3 md:mt-0",
              githubConfig.mirrorStarred ? "opacity-100" : "opacity-0 hidden pointer-events-none"
            )}>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!githubConfig.mirrorStarred}
                    className="h-8 text-xs font-normal min-w-[140px] md:min-w-[140px] justify-between"
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
                              To include more content, enable them in the Content & Data section below
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Duplicate name handling for starred repos */}
          {githubConfig.mirrorStarred && (
            <div className="mt-4 space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                Duplicate name handling
              </Label>
              <div className="flex items-center gap-3">
                <FileCode2 className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1">
                  <p className="text-sm">Name collision strategy</p>
                  <p className="text-xs text-muted-foreground">
                    How to handle repos with the same name from different owners
                  </p>
                </div>
                <Select
                  value={githubConfig.starredDuplicateStrategy || "suffix"}
                  onValueChange={(value) => handleGitHubChange('starredDuplicateStrategy', value as DuplicateNameStrategy)}
                >
                  <SelectTrigger className="w-[180px] h-8 text-xs">
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
              </div>
            </div>
          )}
        </div>
      </div>

      <Separator />

      {/* Content & Data Section */}
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
            <Archive className="h-4 w-4" />
            Content & Data
          </h4>
          <p className="text-xs text-muted-foreground mb-4">
            Select what content to mirror from each repository
          </p>
        </div>

        <div className="space-y-3">
          {/* Code is always mirrored - shown as info */}
          <div className="flex items-center gap-3 p-3 bg-muted/50 dark:bg-muted/20 rounded-md">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <div className="flex-1">
              <p className="text-sm">Source code & branches</p>
              <p className="text-xs text-muted-foreground">Always included</p>
            </div>
            <Badge variant="secondary" className="text-xs">Default</Badge>
          </div>

          <div className="flex items-start space-x-3">
            <Checkbox
              id="mirror-releases"
              checked={mirrorOptions.mirrorReleases}
              onCheckedChange={(checked) => handleMirrorChange('mirrorReleases', !!checked)}
            />
            <div className="space-y-0.5 flex-1">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <Label
                    htmlFor="mirror-releases"
                    className="text-sm font-normal cursor-pointer flex items-center gap-2"
                  >
                    <Tag className="h-3.5 w-3.5" />
                    Releases & Tags
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Include GitHub releases, tags, and associated assets
                  </p>
                </div>
                {mirrorOptions.mirrorReleases && (
                  <div className="flex items-center gap-2 ml-4">
                    <label htmlFor="release-limit" className="text-xs text-muted-foreground">
                      Latest
                    </label>
                    <input
                      id="release-limit"
                      type="number"
                      min="1"
                      max="100"
                      value={mirrorOptions.releaseLimit || 10}
                      onChange={(e) => {
                        const value = parseInt(e.target.value) || 10;
                        const clampedValue = Math.min(100, Math.max(1, value));
                        handleMirrorChange('releaseLimit', clampedValue);
                      }}
                      className="w-16 px-2 py-1 text-xs border border-input rounded bg-background text-foreground"
                    />
                    <span className="text-xs text-muted-foreground">releases</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-start space-x-3">
            <Checkbox
              id="mirror-lfs"
              checked={mirrorOptions.mirrorLFS}
              onCheckedChange={(checked) => handleMirrorChange('mirrorLFS', !!checked)}
            />
            <div className="space-y-0.5 flex-1">
              <Label
                htmlFor="mirror-lfs"
                className="text-sm font-normal cursor-pointer flex items-center gap-2"
              >
                <HardDrive className="h-3.5 w-3.5" />
                Git LFS (Large File Storage)
                <Badge variant="secondary" className="ml-2 text-[10px] px-1.5 py-0">BETA</Badge>
              </Label>
              <p className="text-xs text-muted-foreground">
                Mirror Git LFS objects. Requires LFS to be enabled on your Gitea server and Git v2.1.2+
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-start space-x-3">
              <Checkbox
                id="mirror-metadata"
                checked={mirrorOptions.mirrorMetadata}
                onCheckedChange={(checked) => handleMirrorChange('mirrorMetadata', !!checked)}
              />
              <div className="space-y-0.5 flex-1">
                <Label
                  htmlFor="mirror-metadata"
                  className="text-sm font-normal cursor-pointer flex items-center gap-2"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Repository Metadata
                </Label>
                <p className="text-xs text-muted-foreground">
                  Mirror issues, pull requests, and other repository data
                </p>
              </div>
            </div>

            {/* Metadata multi-select - responsive layout */}
            <div className={cn(
              "flex items-center justify-end transition-opacity duration-200 mt-3 md:mt-0",
              mirrorOptions.mirrorMetadata ? "opacity-100" : "opacity-0 hidden pointer-events-none"
            )}>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!mirrorOptions.mirrorMetadata}
                    className="h-8 text-xs font-normal min-w-[140px] md:min-w-[140px] justify-between"
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
            </div>
          </div>
        </div>
      </div>

      <Separator />

      {/* Filtering & Behavior Section */}
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
            <Funnel className="h-4 w-4" />
            Filtering & Behavior
          </h4>
          <p className="text-xs text-muted-foreground mb-4">
            Fine-tune what gets excluded from mirroring
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="skip-forks"
              checked={advancedOptions.skipForks}
              onCheckedChange={(checked) => handleAdvancedChange('skipForks', !!checked)}
            />
            <div className="space-y-0.5 flex-1">
              <Label
                htmlFor="skip-forks"
                className="text-sm font-normal cursor-pointer flex items-center gap-2"
              >
                <GitFork className="h-3.5 w-3.5" />
                Skip forked repositories
              </Label>
              <p className="text-xs text-muted-foreground">
                Exclude repositories that are forks of other projects
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
