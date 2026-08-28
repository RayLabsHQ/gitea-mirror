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
  alwaysShowDestinationOrg?: boolean;
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
  alwaysShowDestinationOrg = false,
}) => {
  const activeStarredMode = starredReposMode || "dedicated-org";
  const showStarredReposOrgInput = activeStarredMode === "dedicated-org";
  const showDestinationOrgInput = alwaysShowDestinationOrg || strategy === "single-org" || strategy === "mixed";

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
                <p>Choose whether starred repos use one org or keep their source Owner/Org paths</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Label>
        <div className="flex w-full gap-1 rounded-lg bg-muted p-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeStarredMode === "dedicated-org"}
            onClick={() => onStarredReposModeChange("dedicated-org")}
            className={cn(
              "flex h-8 flex-1 items-center justify-center rounded-md text-xs transition-colors",
              activeStarredMode === "dedicated-org"
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Dedicated organization
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeStarredMode === "preserve-owner"}
            onClick={() => onStarredReposModeChange("preserve-owner")}
            className={cn(
              "flex h-8 flex-1 items-center justify-center rounded-md text-xs transition-colors",
              activeStarredMode === "preserve-owner"
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Preserve source owner
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground/80">
          {
            activeStarredMode === "dedicated-org"
              ? "All starred repositories go to a single destination organization"
              : "Starred repositories keep their original GitHub Owner/Org destination"
          }
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
