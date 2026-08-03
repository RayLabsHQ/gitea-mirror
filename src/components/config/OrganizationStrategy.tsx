import React from "react";
import { CircleCheck, Info, GitBranch, FolderTree, Star, Building2, User } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import type { StarredReposMode } from "@/types/config";

export type MirrorStrategy = "preserve" | "single-org" | "flat-user" | "mixed";

interface OrganizationStrategyProps {
  strategy: MirrorStrategy;
  destinationOrg?: string;
  starredReposOrg?: string;
  starredReposMode?: StarredReposMode;
  onStrategyChange: (strategy: MirrorStrategy) => void;
  githubUsername?: string;
  giteaUsername?: string;
}

const strategyConfig = {
  preserve: {
    title: "Preserve Structure",
    icon: FolderTree,
    description: "Keep the exact same org structure as GitHub",
    color: "text-blue-600 dark:text-blue-400",
    bgColor: "bg-blue-50 dark:bg-blue-950/20",
    borderColor: "border-blue-200 dark:border-blue-900",
    repoColors: {
      bg: "bg-blue-50 dark:bg-blue-950/30",
      icon: "text-blue-600 dark:text-blue-400"
    }
  },
  "single-org": {
    title: "Single Organization",
    icon: Building2,
    description: "Consolidate all repositories into one Gitea organization",
    color: "text-purple-600 dark:text-purple-400",
    bgColor: "bg-purple-50 dark:bg-purple-950/20",
    borderColor: "border-purple-200 dark:border-purple-900",
    repoColors: {
      bg: "bg-purple-50 dark:bg-purple-950/30",
      icon: "text-purple-600 dark:text-purple-400"
    }
  },
  "flat-user": {
    title: "User Repositories",
    icon: User,
    description: "Place all repositories directly under your user account",
    color: "text-green-600 dark:text-green-400",
    bgColor: "bg-green-50 dark:bg-green-950/20",
    borderColor: "border-green-200 dark:border-green-900",
    repoColors: {
      bg: "bg-green-50 dark:bg-green-950/30",
      icon: "text-green-600 dark:text-green-400"
    }
  },
  "mixed": {
    title: "Mixed Mode",
    icon: GitBranch,
    description: "Personal repos in single org, org repos preserve structure",
    color: "text-orange-600 dark:text-orange-400",
    bgColor: "bg-orange-50 dark:bg-orange-950/20",
    borderColor: "border-orange-200 dark:border-orange-900",
    repoColors: {
      bg: "bg-orange-50 dark:bg-orange-950/30",
      icon: "text-orange-600 dark:text-orange-400"
    }
  }
};

const MappingPreview: React.FC<{ 
  strategy: MirrorStrategy;
  config: typeof strategyConfig.preserve;
  destinationOrg?: string;
  starredReposOrg?: string;
  starredReposMode?: StarredReposMode;
  githubUsername?: string;
  giteaUsername?: string;
}> = ({ strategy, config, destinationOrg, starredReposOrg, starredReposMode, githubUsername, giteaUsername }) => {
  const displayGithubUsername = githubUsername || "<username>";
  const displayGiteaUsername = giteaUsername || "<username>";
  const isGithubPlaceholder = !githubUsername;
  const isGiteaPlaceholder = !giteaUsername;
  const starredDestination =
    (starredReposMode || "dedicated-org") === "preserve-owner"
      ? "awesome/starred-repo"
      : `${starredReposOrg || "starred"}/starred-repo`;
  
  if (strategy === "preserve") {
    return (
      <div className="flex items-center justify-between gap-6">
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">GitHub</div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <User className="h-3 w-3" />
              <span className={cn(isGithubPlaceholder && "text-muted-foreground italic")}>{displayGithubUsername}/my-repo</span>
            </div>
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <Building2 className="h-3 w-3" />
              <span>my-org/team-repo</span>
            </div>
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <Star className="h-3 w-3" />
              <span>awesome/starred-repo</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
        </div>
        
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">Gitea</div>
          <div className="space-y-1.5">
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <User className={cn("h-3 w-3", config.repoColors.icon)} />
              <span className={cn(isGiteaPlaceholder && "text-muted-foreground italic")}>{displayGiteaUsername}/my-repo</span>
            </div>
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <Building2 className={cn("h-3 w-3", config.repoColors.icon)} />
              <span>my-org/team-repo</span>
            </div>
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <Building2 className={cn("h-3 w-3", config.repoColors.icon)} />
              <span>{starredDestination}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (strategy === "single-org") {
    return (
      <div className="flex items-center justify-between gap-6">
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">GitHub</div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <User className="h-3 w-3" />
              <span className={cn(isGithubPlaceholder && "text-muted-foreground italic")}>{displayGithubUsername}/my-repo</span>
            </div>
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <Building2 className="h-3 w-3" />
              <span>my-org/team-repo</span>
            </div>
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <Star className="h-3 w-3" />
              <span>awesome/starred-repo</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
        </div>
        
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">Gitea</div>
          <div className="space-y-1.5">
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <Building2 className={cn("h-3 w-3", config.repoColors.icon)} />
              <span>{destinationOrg || "github-mirrors"}/my-repo</span>
            </div>
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <Building2 className={cn("h-3 w-3", config.repoColors.icon)} />
              <span>{destinationOrg || "github-mirrors"}/team-repo</span>
            </div>
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <Building2 className={cn("h-3 w-3", config.repoColors.icon)} />
              <span>{starredDestination}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (strategy === "flat-user") {
    return (
      <div className="flex items-center justify-between gap-6">
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">GitHub</div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <User className="h-3 w-3" />
              <span className={cn(isGithubPlaceholder && "text-muted-foreground italic")}>{displayGithubUsername}/my-repo</span>
            </div>
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <Building2 className="h-3 w-3" />
              <span>my-org/team-repo</span>
            </div>
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <Star className="h-3 w-3" />
              <span>awesome/starred-repo</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
        </div>
        
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">Gitea</div>
          <div className="space-y-1.5">
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <User className={cn("h-3 w-3", config.repoColors.icon)} />
              <span className={cn(isGiteaPlaceholder && "text-muted-foreground italic")}>{displayGiteaUsername}/my-repo</span>
            </div>
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <User className={cn("h-3 w-3", config.repoColors.icon)} />
              <span className={cn(isGiteaPlaceholder && "text-muted-foreground italic")}>{displayGiteaUsername}/team-repo</span>
            </div>
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <Building2 className={cn("h-3 w-3", config.repoColors.icon)} />
              <span>{starredDestination}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (strategy === "mixed") {
    return (
      <div className="flex items-center justify-between gap-6">
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">GitHub</div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <User className="h-3 w-3" />
              <span className={cn(isGithubPlaceholder && "text-muted-foreground italic")}>{displayGithubUsername}/my-repo</span>
            </div>
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <Building2 className="h-3 w-3" />
              <span>my-org/team-repo</span>
            </div>
            <div className="flex items-center gap-2 p-1.5 bg-gray-50 dark:bg-gray-800 rounded text-xs">
              <Star className="h-3 w-3" />
              <span>awesome/starred-repo</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
        </div>
        
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">Gitea</div>
          <div className="space-y-1.5">
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <Building2 className={cn("h-3 w-3", config.repoColors.icon)} />
              <span>{destinationOrg || "github-mirrors"}/my-repo</span>
            </div>
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <Building2 className={cn("h-3 w-3", config.repoColors.icon)} />
              <span>my-org/team-repo</span>
            </div>
            <div className={cn("flex items-center gap-2 p-1.5 rounded text-xs", config.repoColors.bg)}>
              <Building2 className={cn("h-3 w-3", config.repoColors.icon)} />
              <span>{starredDestination}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }
  
  return null;
};

export const OrganizationStrategy: React.FC<OrganizationStrategyProps> = ({
  strategy,
  destinationOrg,
  starredReposOrg,
  starredReposMode,
  onStrategyChange,
  githubUsername,
  giteaUsername,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="flex-1">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Organization strategy
          </span>
        </div>
        
        <div className="flex-shrink-0">
          <HoverCard openDelay={200}>
            <HoverCardTrigger asChild>
              <button 
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                type="button"
              >
                <Info className="h-3.5 w-3.5" />
                <span>Override Options</span>
              </button>
            </HoverCardTrigger>
            <HoverCardContent side="bottom" align="start" className="w-[380px]">
              <div className="space-y-3">
                <div>
                  <h4 className="font-medium text-sm mb-1.5">Fine-tune Your Mirror Destinations</h4>
                  <p className="text-xs text-muted-foreground">
                    After selecting a strategy, you can customize destinations for specific organizations and repositories.
                  </p>
                </div>
                
                <div className="space-y-2.5 pt-2 border-t">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-3.5 w-3.5 text-primary" />
                      <span className="text-xs font-medium">Organization Overrides</span>
                    </div>
                    <p className="text-xs text-muted-foreground pl-5">
                      Click the edit button on any organization card to redirect all its repositories to a different Gitea organization.
                    </p>
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <GitBranch className="h-3.5 w-3.5 text-primary" />
                      <span className="text-xs font-medium">Repository Overrides</span>
                    </div>
                    <p className="text-xs text-muted-foreground pl-5">
                      Use the inline editor in the repository table's "Destination" column to set custom destinations for individual repositories.
                    </p>
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Star className="h-3.5 w-3.5 text-yellow-500" />
                      <span className="text-xs font-medium">Starred Repositories</span>
                    </div>
                    <p className="text-xs text-muted-foreground pl-5">
                      Follow your starred-repo mode and cannot be overridden per repository.
                    </p>
                  </div>
                </div>
                
                <div className="pt-2 border-t">
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">Priority:</span> Repository override → Organization override → Strategy default
                  </p>
                </div>
              </div>
            </HoverCardContent>
          </HoverCard>
        </div>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3" role="radiogroup">
        {(Object.entries(strategyConfig) as [MirrorStrategy, typeof strategyConfig.preserve][]).map(([key, config]) => {
          const isSelected = strategy === key;
          const Icon = config.icon;

          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onStrategyChange(key)}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-3.5 text-left transition-colors",
                isSelected
                  ? "border-indigo-500 bg-indigo-500/10"
                  : "border-border hover:border-muted-foreground/40"
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                  isSelected
                    ? "bg-indigo-500/20 text-indigo-400"
                    : "bg-muted text-muted-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>

              <span className="flex-1 min-w-0 space-y-1">
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "text-[13px] font-medium leading-none",
                      isSelected ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {config.title}
                  </span>
                  <HoverCard openDelay={200}>
                    <HoverCardTrigger asChild>
                      <span
                        className="inline-flex cursor-help text-muted-foreground/50 hover:text-muted-foreground"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Info className="h-3.5 w-3.5" />
                      </span>
                    </HoverCardTrigger>
                    <HoverCardContent side="left" align="center" className="w-[500px]">
                      <div className="space-y-3">
                        <h4 className="font-medium text-sm">Repository Mapping Preview</h4>
                        <MappingPreview
                          strategy={key}
                          config={config}
                          destinationOrg={destinationOrg}
                          starredReposOrg={starredReposOrg}
                          starredReposMode={starredReposMode}
                          githubUsername={githubUsername}
                          giteaUsername={giteaUsername}
                        />
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </span>
                <span className="block text-[11px] leading-relaxed text-muted-foreground">
                  {config.description}
                </span>
              </span>

              {isSelected && (
                <CircleCheck className="h-4 w-4 shrink-0 text-indigo-500" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
