import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import type {
  MirrorPairOptions,
  MirrorType,
  Server,
  ServerType,
} from "@/lib/db/schema";
import {
  CAPABILITY_LABELS,
  getCapabilityUnavailableReason,
  getPairCapabilities,
  type MirrorContentCapability,
} from "@/lib/server-capabilities";
import { apiRequest, showErrorToast } from "@/lib/utils";
import {
  SERVER_TYPE_LABELS,
  type MatrixPairApiResponse,
  type MirrorPairWithServers,
} from "./shared";

/** Mirror content options shown in the dialog (refs is always mirrored). */
const MIRROR_CONTENT_KEYS = [
  "releases",
  "lfs",
  "issues",
  "pullRequests",
  "labels",
  "milestones",
  "wiki",
] as const satisfies readonly MirrorContentCapability[];

type MirrorContentKey = (typeof MIRROR_CONTENT_KEYS)[number];

const BACKUP_STRATEGIES = [
  { value: "disabled", label: "Disabled" },
  { value: "always", label: "Always" },
  { value: "on-force-push", label: "On force push" },
  { value: "block-on-force-push", label: "Block on force push" },
] as const;

const DEFAULT_OPTIONS: MirrorPairOptions = {
  repositorySelection: {
    mode: "all",
    selectedRepos: [],
    includePatterns: [],
    excludePatterns: [],
    includeForks: false,
    includeArchived: false,
    includePrivate: true,
  },
  organizationStructure: {
    strategy: "preserve",
  },
  destructiveProtection: {
    detectForcePush: true,
    backupStrategy: "on-force-push",
    backupRetentionCount: 5,
    backupRetentionDays: 30,
  },
  mirrorContent: {
    releases: false,
    lfs: false,
    issues: false,
    pullRequests: false,
    labels: false,
    milestones: false,
    wiki: false,
  },
};

function mergeOptions(options?: MirrorPairOptions): MirrorPairOptions {
  return {
    repositorySelection: {
      ...DEFAULT_OPTIONS.repositorySelection,
      ...options?.repositorySelection,
    },
    organizationStructure: {
      ...DEFAULT_OPTIONS.organizationStructure,
      ...options?.organizationStructure,
    },
    destructiveProtection: {
      ...DEFAULT_OPTIONS.destructiveProtection,
      ...options?.destructiveProtection,
    },
    mirrorContent: {
      ...DEFAULT_OPTIONS.mirrorContent,
      ...options?.mirrorContent,
    },
  };
}

function linesToList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface PairSettingsDialogProps {
  pair: MirrorPairWithServers | null;
  servers: Server[];
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  onSaved: () => void;
}

export function PairSettingsDialog({
  pair,
  servers,
  isOpen,
  setIsOpen,
  onSaved,
}: PairSettingsDialogProps) {
  const [options, setOptions] = useState<MirrorPairOptions>(DEFAULT_OPTIONS);
  const [mirrorType, setMirrorType] = useState<MirrorType>("one-way");
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen && pair) {
      setOptions(mergeOptions(pair.options));
      setMirrorType(pair.mirrorType);
    }
  }, [isOpen, pair]);

  // Resolve the full server records so LFS endpoints can gate capabilities
  const sourceServer = useMemo(
    () => servers.find((s) => s.id === pair?.sourceServerId),
    [servers, pair?.sourceServerId]
  );
  const targetServer = useMemo(
    () => servers.find((s) => s.id === pair?.targetServerId),
    [servers, pair?.targetServerId]
  );

  const sourceType: ServerType = sourceServer?.type ?? pair?.sourceServer?.type ?? "git";
  const targetType: ServerType = targetServer?.type ?? pair?.targetServer?.type ?? "git";

  const capabilities = getPairCapabilities(sourceType, targetType, {
    sourceLfsEndpoint: sourceServer?.lfsEndpoint,
    targetLfsEndpoint: targetServer?.lfsEndpoint,
  });

  const unavailableReason = (key: MirrorContentCapability): string | null => {
    if (capabilities.includes(key)) {
      return null;
    }
    return (
      getCapabilityUnavailableReason(sourceType, key, {
        lfsEndpoint: sourceServer?.lfsEndpoint,
      }) ??
      getCapabilityUnavailableReason(targetType, key, {
        lfsEndpoint: targetServer?.lfsEndpoint,
      }) ??
      "Not supported by this server pair."
    );
  };

  const updateRepositorySelection = (
    patch: Partial<MirrorPairOptions["repositorySelection"]>
  ) => {
    setOptions((prev) => ({
      ...prev,
      repositorySelection: { ...prev.repositorySelection, ...patch },
    }));
  };

  const updateOrganizationStructure = (
    patch: Partial<MirrorPairOptions["organizationStructure"]>
  ) => {
    setOptions((prev) => ({
      ...prev,
      organizationStructure: { ...prev.organizationStructure, ...patch },
    }));
  };

  const updateDestructiveProtection = (
    patch: Partial<MirrorPairOptions["destructiveProtection"]>
  ) => {
    setOptions((prev) => ({
      ...prev,
      destructiveProtection: { ...prev.destructiveProtection, ...patch },
    }));
  };

  const updateMirrorContent = (key: MirrorContentKey, checked: boolean) => {
    setOptions((prev) => ({
      ...prev,
      mirrorContent: { ...prev.mirrorContent, [key]: checked },
    }));
  };

  const handleSave = async () => {
    if (!pair) {
      return;
    }

    try {
      setIsSaving(true);

      const response = await apiRequest<MatrixPairApiResponse>(
        `/matrix/${pair.id}`,
        {
          method: "PUT",
          data: { options, mirrorType },
        }
      );

      if (response.success) {
        toast.success(response.message || "Pair settings saved");
        setIsOpen(false);
        onSaved();
      } else {
        showErrorToast(response.message || "Failed to save pair settings", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsSaving(false);
    }
  };

  const selection = options.repositorySelection;
  const orgStructure = options.organizationStructure;
  const protection = options.destructiveProtection;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="w-[calc(100%-2rem)] sm:max-w-[560px] gap-0 gap-y-4 mx-4 sm:mx-0 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Pair Settings</DialogTitle>
          <DialogDescription>
            {pair
              ? `${SERVER_TYPE_LABELS[sourceType]} → ${SERVER_TYPE_LABELS[targetType]} mirror settings`
              : "Mirror pair settings"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-y-6">
          <div>
            <Label className="block text-sm font-medium mb-1.5">Mirror Type</Label>
            <Select
              value={mirrorType}
              onValueChange={(val) => setMirrorType(val as MirrorType)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select mirror type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one-way">{"=> Source to Target"}</SelectItem>
                <SelectItem value="two-way">{"<=> Two Way Mirror"}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* 1. Repository Selection */}
          <section className="flex flex-col gap-y-3">
            <h4 className="text-sm font-semibold">Repository Selection</h4>

            <RadioGroup
              value={selection.mode}
              onValueChange={(val) =>
                updateRepositorySelection({
                  mode: val as MirrorPairOptions["repositorySelection"]["mode"],
                })
              }
              className="flex flex-col gap-y-2"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="all" id="mode-all" />
                <Label htmlFor="mode-all">All repositories</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="selected" id="mode-selected" />
                <Label htmlFor="mode-selected">Selected repositories</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="patterns" id="mode-patterns" />
                <Label htmlFor="mode-patterns">Include / exclude patterns</Label>
              </div>
            </RadioGroup>

            {selection.mode === "selected" && (
              <div>
                <Label htmlFor="selected-repos" className="block text-sm mb-1.5">
                  Repositories (one per line)
                </Label>
                <Textarea
                  id="selected-repos"
                  value={selection.selectedRepos.join("\n")}
                  onChange={(e) =>
                    updateRepositorySelection({
                      selectedRepos: linesToList(e.target.value),
                    })
                  }
                  placeholder={"owner/repo-one\nowner/repo-two"}
                  rows={4}
                />
              </div>
            )}

            {selection.mode === "patterns" && (
              <div className="flex flex-col gap-y-3">
                <div>
                  <Label htmlFor="include-patterns" className="block text-sm mb-1.5">
                    Include patterns (one per line)
                  </Label>
                  <Textarea
                    id="include-patterns"
                    value={selection.includePatterns.join("\n")}
                    onChange={(e) =>
                      updateRepositorySelection({
                        includePatterns: linesToList(e.target.value),
                      })
                    }
                    placeholder={"my-org/*\n*-service"}
                    rows={3}
                  />
                </div>
                <div>
                  <Label htmlFor="exclude-patterns" className="block text-sm mb-1.5">
                    Exclude patterns (one per line)
                  </Label>
                  <Textarea
                    id="exclude-patterns"
                    value={selection.excludePatterns.join("\n")}
                    onChange={(e) =>
                      updateRepositorySelection({
                        excludePatterns: linesToList(e.target.value),
                      })
                    }
                    placeholder={"*-archive\ntmp/*"}
                    rows={3}
                  />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-y-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-forks"
                  checked={selection.includeForks}
                  onCheckedChange={(checked) =>
                    updateRepositorySelection({ includeForks: checked === true })
                  }
                />
                <Label htmlFor="include-forks">Include forks</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-archived"
                  checked={selection.includeArchived}
                  onCheckedChange={(checked) =>
                    updateRepositorySelection({ includeArchived: checked === true })
                  }
                />
                <Label htmlFor="include-archived">Include archived repositories</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-private"
                  checked={selection.includePrivate}
                  onCheckedChange={(checked) =>
                    updateRepositorySelection({ includePrivate: checked === true })
                  }
                />
                <Label htmlFor="include-private">Include private repositories</Label>
              </div>
            </div>
          </section>

          {/* 2. Organization Structure */}
          <section className="flex flex-col gap-y-3">
            <h4 className="text-sm font-semibold">Organization Structure</h4>

            <div>
              <Label className="block text-sm mb-1.5">Strategy</Label>
              <Select
                value={orgStructure.strategy}
                onValueChange={(val) =>
                  updateOrganizationStructure({
                    strategy:
                      val as MirrorPairOptions["organizationStructure"]["strategy"],
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select strategy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preserve">Preserve structure</SelectItem>
                  <SelectItem value="single-org">Single org</SelectItem>
                  <SelectItem value="flat-user">Flat (under user)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {orgStructure.strategy === "single-org" && (
              <div>
                <Label htmlFor="single-org" className="block text-sm mb-1.5">
                  Organization name
                </Label>
                <Input
                  id="single-org"
                  type="text"
                  value={orgStructure.singleOrg ?? ""}
                  onChange={(e) =>
                    updateOrganizationStructure({ singleOrg: e.target.value })
                  }
                  placeholder="e.g., github-mirrors"
                  autoComplete="off"
                />
              </div>
            )}
          </section>

          {/* 3. Destructive Update Protection */}
          <section className="flex flex-col gap-y-3">
            <h4 className="text-sm font-semibold">Destructive Update Protection</h4>

            <div className="flex items-center justify-between">
              <Label htmlFor="detect-force-push">Detect force pushes</Label>
              <Switch
                id="detect-force-push"
                checked={protection.detectForcePush}
                onCheckedChange={(checked) =>
                  updateDestructiveProtection({ detectForcePush: checked })
                }
              />
            </div>

            <div>
              <Label className="block text-sm mb-1.5">Backup strategy</Label>
              <Select
                value={protection.backupStrategy}
                onValueChange={(val) =>
                  updateDestructiveProtection({
                    backupStrategy:
                      val as MirrorPairOptions["destructiveProtection"]["backupStrategy"],
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select backup strategy" />
                </SelectTrigger>
                <SelectContent>
                  {BACKUP_STRATEGIES.map((strategy) => (
                    <SelectItem key={strategy.value} value={strategy.value}>
                      {strategy.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="backup-retention-count" className="block text-sm mb-1.5">
                  Backup retention count
                </Label>
                <Input
                  id="backup-retention-count"
                  type="number"
                  min={1}
                  value={protection.backupRetentionCount}
                  onChange={(e) =>
                    updateDestructiveProtection({
                      backupRetentionCount: Math.max(
                        1,
                        Number.parseInt(e.target.value, 10) || 1
                      ),
                    })
                  }
                />
              </div>
              <div>
                <Label htmlFor="backup-retention-days" className="block text-sm mb-1.5">
                  Backup retention days
                </Label>
                <Input
                  id="backup-retention-days"
                  type="number"
                  min={0}
                  value={protection.backupRetentionDays}
                  onChange={(e) =>
                    updateDestructiveProtection({
                      backupRetentionDays: Math.max(
                        0,
                        Number.parseInt(e.target.value, 10) || 0
                      ),
                    })
                  }
                />
              </div>
            </div>
          </section>

          {/* 4. Mirror Content */}
          <section className="flex flex-col gap-y-3">
            <h4 className="text-sm font-semibold">Mirror Content</h4>
            <p className="text-xs text-muted-foreground">
              Branches and tags (git refs) are always mirrored.
            </p>

            <TooltipProvider>
              <div className="flex flex-col gap-y-2">
                {MIRROR_CONTENT_KEYS.map((key) => {
                  const reason = unavailableReason(key);

                  const row = (
                    <div
                      className={`flex items-center space-x-2 ${
                        reason ? "opacity-60" : ""
                      }`}
                    >
                      <Checkbox
                        id={`mirror-content-${key}`}
                        checked={options.mirrorContent[key]}
                        disabled={reason !== null}
                        onCheckedChange={(checked) =>
                          updateMirrorContent(key, checked === true)
                        }
                      />
                      <Label
                        htmlFor={`mirror-content-${key}`}
                        className={reason ? "cursor-not-allowed" : undefined}
                      >
                        {CAPABILITY_LABELS[key]}
                      </Label>
                    </div>
                  );

                  if (!reason) {
                    return <div key={key}>{row}</div>;
                  }

                  return (
                    <Tooltip key={key} delayDuration={0}>
                      <TooltipTrigger asChild>
                        <div>{row}</div>
                      </TooltipTrigger>
                      <TooltipContent side="right">{reason}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </TooltipProvider>
          </section>

          <div className="flex justify-between pt-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => setIsOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving || !pair}>
              {isSaving ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                "Save Settings"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
