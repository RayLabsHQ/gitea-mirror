import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Star, Globe, Lock, Shield, Info, MonitorCog } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MirrorStrategy, GiteaOrgVisibility, StarredReposMode } from "@/types/config";
import { normalizeStarredReposMode } from "@/lib/utils/starred-destination";

/**
 * The three places starred repositories can go (#551). "Preserve source owner"
 * keeps the GitHub owner's name whatever the strategy says, which is not the
 * same as following the strategy; the descriptions spell that out.
 */
const STARRED_MODE_OPTIONS: { value: StarredReposMode; label: string; description: string }[] = [
  {
    value: "dedicated-org",
    label: "Dedicated organization",
    description: "All starred repositories go to one organization of their own",
  },
  {
    value: "preserve-owner",
    label: "Preserve source owner",
    description:
      "Each starred repository goes under its GitHub owner's name, whatever the mirror strategy says",
  },
  {
    value: "follow-strategy",
    label: "Same as other repos",
    description:
      "Starred repositories go wherever the mirror strategy and destination settings put any other repository",
  },
];

interface OrganizationConfigurationProps {
  strategy: MirrorStrategy;
  destinationOrg?: string;
  starredReposOrg?: string;
  starredReposMode?: StarredReposMode;
  personalReposOrg?: string;
  visibility: GiteaOrgVisibility;
  onDestinationOrgChange: (org: string) => void;
  onStarredReposOrgChange: (org: string) => void;
  onStarredReposModeChange: (mode: StarredReposMode) => void;
  onPersonalReposOrgChange: (org: string) => void;
  onVisibilityChange: (visibility: GiteaOrgVisibility) => void;
}

const visibilityOptions = [
  { value: "public" as GiteaOrgVisibility, label: "Public", icon: Globe, description: "Visible to everyone" },
  { value: "private" as GiteaOrgVisibility, label: "Private", icon: Lock, description: "Visible to members only" },
  { value: "limited" as GiteaOrgVisibility, label: "Limited", icon: Shield, description: "Visible to logged-in users" },
];

export const OrganizationConfiguration: React.FC<OrganizationConfigurationProps> = ({
  strategy,
  destinationOrg,
  starredReposOrg,
  starredReposMode,
  personalReposOrg,
  visibility,
  onDestinationOrgChange,
  onStarredReposOrgChange,
  onStarredReposModeChange,
  onPersonalReposOrgChange,
  onVisibilityChange,
}) => {
  const activeStarredMode = normalizeStarredReposMode(starredReposMode);
  const showStarredReposOrgInput = activeStarredMode === "dedicated-org";
  const showDestinationOrgInput = strategy === "single-org" || strategy === "mixed";

  return (
    <div className="space-y-4">
      <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Organization configuration
      </span>

      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground flex items-center gap-2">
          Starred repository destination
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Info className="h-3.5 w-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>
                <p>Where starred repositories are mirrored to</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Label>
        <div className="flex w-full gap-1 rounded-lg bg-muted p-1" role="tablist">
          {STARRED_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={activeStarredMode === option.value}
              onClick={() => onStarredReposModeChange(option.value)}
              className={cn(
                "flex min-h-8 flex-1 items-center justify-center rounded-md px-2 py-1 text-center text-xs leading-tight transition-colors",
                activeStarredMode === option.value
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground/80">
          {STARRED_MODE_OPTIONS.find((option) => option.value === activeStarredMode)?.description}
        </p>
      </div>

      {/* First row - Organization inputs */}
      {(showStarredReposOrgInput || showDestinationOrgInput) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {showStarredReposOrgInput ? (
            <div className="space-y-1">
              <Label htmlFor="starredReposOrg" className="text-sm font-normal flex items-center gap-2">
                <Star className="h-3.5 w-3.5" />
                Starred Repos Organization
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3.5 w-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Starred repositories will be organized separately in this organization</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id="starredReposOrg"
                value={starredReposOrg || ""}
                onChange={(e) => onStarredReposOrgChange(e.target.value)}
                placeholder="starred"
                className=""
              />
              <p className="text-xs text-muted-foreground mt-1">
                Keep starred repos organized separately
              </p>
            </div>
          ) : (
            <div className="hidden md:block" />
          )}

          {showDestinationOrgInput ? (
          <div className="space-y-1">
            <Label htmlFor="destinationOrg" className="text-sm font-normal flex items-center gap-2">
              {strategy === "mixed" ? "Personal Repos Organization" : "Destination Organization"}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {strategy === "mixed"
                        ? "Personal repositories will be mirrored to this organization, while organization repos preserve their structure"
                        : "All repositories will be mirrored to this organization"
                      }
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </Label>
            <Input
              id="destinationOrg"
              value={destinationOrg || ""}
              onChange={(e) => onDestinationOrgChange(e.target.value)}
              placeholder={strategy === "mixed" ? "github-personal" : "github-mirrors"}
              className=""
            />
            <p className="text-xs text-muted-foreground mt-1">
              {strategy === "mixed"
                ? "All personal repos will go to this organization"
                : "Organization for consolidated repositories"
              }
            </p>
          </div>
          ) : (
            <div className="hidden md:block" />
          )}
        </div>
      )}

      {/* Second row - Organization Visibility (always shown) */}
      <div className="space-y-2">
        <Label className="text-sm font-normal flex items-center gap-2">
          Organization Visibility
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Info className="h-3.5 w-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>
                <p>Default visibility for newly created organizations</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Label>
        <div className="flex w-full gap-1 rounded-lg bg-muted p-1" role="tablist">
          {visibilityOptions.map((option) => {
            const Icon = option.icon;
            const isSelected = visibility === option.value;
            return (
              <TooltipProvider key={option.value}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      onClick={() => onVisibilityChange(option.value)}
                      className={cn(
                        "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs transition-colors",
                        isSelected
                          ? "bg-background font-medium text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Icon className="h-3 w-3" />
                      {option.label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">{option.description}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          })}
        </div>
      </div>
    </div>
  );
};
