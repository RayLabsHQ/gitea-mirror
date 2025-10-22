import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Clock,
  Database,
  RefreshCw,
  Calendar,
  Activity,
  Zap,
  Info,
  Archive,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ScheduleConfig, DatabaseCleanupConfig } from "@/types/config";
import { formatDate } from "@/lib/utils";

interface AutomationSettingsProps {
  scheduleConfig: ScheduleConfig;
  cleanupConfig: DatabaseCleanupConfig;
  onScheduleChange: (config: ScheduleConfig) => void;
  onCleanupChange: (config: DatabaseCleanupConfig) => void;
  isAutoSavingSchedule?: boolean;
  isAutoSavingCleanup?: boolean;
}

const scheduleIntervals = [
  { label: "Every hour", value: 3600 },
  { label: "Every 2 hours", value: 7200 },
  { label: "Every 4 hours", value: 14400 },
  { label: "Every 8 hours", value: 28800 },
  { label: "Every 12 hours", value: 43200 },
  { label: "Daily", value: 86400 },
  { label: "Every 2 days", value: 172800 },
  { label: "Weekly", value: 604800 },
];

const retentionPeriods = [
  { label: "1 day", value: 86400 },
  { label: "3 days", value: 259200 },
  { label: "1 week", value: 604800 },
  { label: "2 weeks", value: 1209600 },
  { label: "1 month", value: 2592000 },
  { label: "2 months", value: 5184000 },
  { label: "3 months", value: 7776000 },
];

function getCleanupInterval(retentionSeconds: number): number {
  const days = retentionSeconds / 86400;
  if (days <= 1) return 21600; // 6 hours
  if (days <= 3) return 43200; // 12 hours
  if (days <= 7) return 86400; // 24 hours
  if (days <= 30) return 172800; // 48 hours
  return 604800; // 1 week
}

function getCleanupFrequencyText(retentionSeconds: number): string {
  const days = retentionSeconds / 86400;
  if (days <= 1) return "every 6 hours";
  if (days <= 3) return "every 12 hours";
  if (days <= 7) return "daily";
  if (days <= 30) return "every 2 days";
  return "weekly";
}

export function AutomationSettings({
  scheduleConfig,
  cleanupConfig,
  onScheduleChange,
  onCleanupChange,
  isAutoSavingSchedule,
  isAutoSavingCleanup,
}: AutomationSettingsProps) {
  // Update nextRun for cleanup when settings change
  useEffect(() => {
    if (cleanupConfig.enabled && !cleanupConfig.nextRun) {
      const cleanupInterval = getCleanupInterval(cleanupConfig.retentionDays);
      const nextRun = new Date(Date.now() + cleanupInterval * 1000);
      onCleanupChange({ ...cleanupConfig, nextRun });
    }
  }, [cleanupConfig.enabled, cleanupConfig.retentionDays]);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Zap className="h-5 w-5" />
          Automation & Maintenance
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="ml-1 inline-flex items-center justify-center rounded-full w-4 h-4 bg-muted hover:bg-muted/80 transition-colors">
                  <Info className="h-3 w-3" />
                  <span className="sr-only">Background operations info</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                <div className="space-y-2">
                  <p className="font-medium">Background Operations</p>
                  <p className="text-xs">
                    These automated tasks run in the background to keep your mirrors up-to-date and maintain optimal database performance. 
                    Choose intervals that match your workflow and repository update frequency.
                  </p>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardTitle>
      </CardHeader>
      
  <CardContent className="space-y-6">
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Automatic Syncing Section */}
      <div className="space-y-4 p-4 border border-border rounded-lg bg-card/50">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-primary" />
                Automatic Syncing
              </h3>
              {isAutoSavingSchedule && (
                <Activity className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>

            <div className="space-y-4">
              <div className="flex items-start space-x-3">
                <Checkbox
                  id="enable-auto-mirror"
                  checked={scheduleConfig.enabled}
                  className="mt-1.25"
                  onCheckedChange={(checked) =>
                    onScheduleChange({ ...scheduleConfig, enabled: !!checked })
                  }
                />
                <div className="space-y-0.5 flex-1">
                  <Label
                    htmlFor="enable-auto-mirror"
                    className="text-sm font-normal cursor-pointer"
                  >
                    Enable automatic repository syncing
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Periodically check GitHub for changes and mirror them to Gitea
                  </p>
                </div>
              </div>

              {scheduleConfig.enabled && (
                <div className="ml-6 space-y-3">
                  <div>
                    <Label htmlFor="mirror-interval" className="text-sm">
                      Sync frequency
                    </Label>
                    <Select
                      value={scheduleConfig.interval.toString()}
                      onValueChange={(value) =>
                        onScheduleChange({
                          ...scheduleConfig,
                          interval: parseInt(value, 10),
                        })
                      }
                    >
                      <SelectTrigger id="mirror-interval" className="mt-1.5">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {scheduleIntervals.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value.toString()}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <div className="space-y-2 p-3 bg-muted/30 dark:bg-muted/10 rounded-md border border-border/50">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    Last sync
                  </span>
                  <span className="font-medium text-muted-foreground">
                    {scheduleConfig.lastRun
                      ? formatDate(scheduleConfig.lastRun)
                      : "Never"}
                  </span>
                </div>
                {scheduleConfig.enabled ? (
                  scheduleConfig.nextRun && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5" />
                        Next sync
                      </span>
                      <span className="font-medium">
                        {formatDate(scheduleConfig.nextRun)}
                      </span>
                    </div>
                  )
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Enable automatic syncing to schedule periodic repository updates
                  </div>
                )}
          </div>
        </div>
      </div>

      {/* Database Cleanup Section */}
      <div className="space-y-4 p-4 border border-border rounded-lg bg-card/50">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            Database Maintenance
          </h3>
              {isAutoSavingCleanup && (
                <Activity className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>

            <div className="space-y-4">
              <div className="flex items-start space-x-3">
                <Checkbox
                  id="enable-auto-cleanup"
                  checked={cleanupConfig.enabled}
                  className="mt-1.25"
                  onCheckedChange={(checked) =>
                    onCleanupChange({ ...cleanupConfig, enabled: !!checked })
                  }
                />
                <div className="space-y-0.5 flex-1">
                  <Label
                    htmlFor="enable-auto-cleanup"
                    className="text-sm font-normal cursor-pointer"
                  >
                    Enable automatic database cleanup
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Remove old activity logs and events to optimize storage
                  </p>
                </div>
              </div>

              {cleanupConfig.enabled && (
                <div className="ml-6 space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="retention-period" className="text-sm flex items-center gap-2">
                      Data retention period
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <Info className="h-3 w-3 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs">
                            <p className="text-xs">
                              Activity logs and events older than this will be removed. 
                              Cleanup frequency is automatically optimized based on your retention period.
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </Label>
                    <Select
                      value={cleanupConfig.retentionDays.toString()}
                      onValueChange={(value) =>
                        onCleanupChange({
                          ...cleanupConfig,
                          retentionDays: parseInt(value, 10),
                        })
                      }
                    >
                      <SelectTrigger id="retention-period" className="mt-1.5">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {retentionPeriods.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value.toString()}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {cleanupConfig.enabled && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Cleanup runs {getCleanupFrequencyText(cleanupConfig.retentionDays)}
                      </p>
                    )}
                  </div>

                </div>
              )}

              <div className="space-y-2 p-3 bg-muted/30 dark:bg-muted/10 rounded-md border border-border/50">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    Last cleanup
                  </span>
                  <span className="font-medium text-muted-foreground">
                    {cleanupConfig.lastRun
                      ? formatDate(cleanupConfig.lastRun)
                      : "Never"}
                  </span>
                </div>
                {cleanupConfig.enabled ? (
                  cleanupConfig.nextRun && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5" />
                        Next cleanup
                      </span>
                      <span className="font-medium">
                        {formatDate(cleanupConfig.nextRun)}
                      </span>
                    </div>
                  )
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Enable automatic cleanup to optimize database storage
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Repository Cleanup Section */}
      <div className="space-y-4 p-4 border border-border rounded-lg bg-card/50 md:col-span-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Archive className="h-4 w-4 text-primary" />
            Repository Cleanup (orphaned mirrors)
          </h3>
          {isAutoSavingCleanup && (
            <Activity className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>

        <div className="space-y-4">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="cleanup-handle-orphans"
              checked={Boolean(cleanupConfig.deleteIfNotInGitHub)}
              className="mt-1.25"
              onCheckedChange={(checked) =>
                onCleanupChange({
                  ...cleanupConfig,
                  deleteIfNotInGitHub: Boolean(checked),
                })
              }
            />
            <div className="space-y-0.5 flex-1">
              <Label
                htmlFor="cleanup-handle-orphans"
                className="text-sm font-normal cursor-pointer"
              >
                Handle orphaned repositories automatically
              </Label>
              <p className="text-xs text-muted-foreground">
                Keep your Gitea backups when GitHub repos disappear. Archive is the safest option—it preserves data and disables automatic syncs.
              </p>
            </div>
          </div>

          {cleanupConfig.deleteIfNotInGitHub && (
            <div className="space-y-3 ml-6">
              <div className="space-y-1">
                <Label htmlFor="cleanup-orphaned-action" className="text-sm font-medium">
                  Action for orphaned repositories
                </Label>
                <Select
                  value={cleanupConfig.orphanedRepoAction ?? "archive"}
                  onValueChange={(value) =>
                    onCleanupChange({
                      ...cleanupConfig,
                      orphanedRepoAction: value as DatabaseCleanupConfig["orphanedRepoAction"],
                    })
                  }
                >
                  <SelectTrigger id="cleanup-orphaned-action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="archive">Archive (preserve data)</SelectItem>
                    <SelectItem value="skip">Skip (leave as-is)</SelectItem>
                    <SelectItem value="delete">Delete from Gitea</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Archive renames mirror backups with an <code>archived-</code> prefix and disables automatic syncs—use Manual Sync when you want to refresh.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label
                    htmlFor="cleanup-dry-run"
                    className="text-sm font-normal cursor-pointer"
                  >
                    Dry run (log only)
                  </Label>
                  <p className="text-xs text-muted-foreground max-w-xl">
                    When enabled, cleanup logs the planned action without modifying repositories.
                  </p>
                </div>
                <Switch
                  id="cleanup-dry-run"
                  checked={Boolean(cleanupConfig.dryRun)}
                  onCheckedChange={(checked) =>
                    onCleanupChange({
                      ...cleanupConfig,
                      dryRun: Boolean(checked),
                    })
                  }
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  </CardContent>
    </Card>
  );
}
