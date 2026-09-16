import { useEffect, useMemo } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Clock,
  Database,
  RefreshCw,
  Calendar,
  Activity,
  Archive,
  ArchiveRestore,
  CircleOff,
  Globe,
  History,
  Info,
  Trash2,
} from "lucide-react";
import type { ScheduleConfig, DatabaseCleanupConfig } from "@/types/config";
import { formatDate } from "@/lib/utils";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import {
  buildClockCronExpression,
  getNextCronOccurrence,
} from "@/lib/utils/schedule-utils";
import {
  SettingsCard,
  SectionTitle,
  SwitchRow,
  OptionTile,
  StatusFooterItem,
  CardDivider,
  CardSection,
} from "./settings-ui";
import { ReconcileDestinationButton } from "./ReconcileDialog";

interface AutomationSettingsProps {
  scheduleConfig: ScheduleConfig;
  cleanupConfig: DatabaseCleanupConfig;
  onScheduleChange: (config: ScheduleConfig) => void;
  onCleanupChange: (config: DatabaseCleanupConfig) => void;
  isAutoSavingSchedule?: boolean;
  isAutoSavingCleanup?: boolean;
}

const clockFrequencies = [
  { label: "Every hour", value: 1 },
  { label: "Every 2 hours", value: 2 },
  { label: "Every 4 hours", value: 4 },
  { label: "Every 8 hours", value: 8 },
  { label: "Every 12 hours", value: 12 },
  { label: "Daily", value: 24 },
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

/** "every 8 hours", "every 30 minutes", "every 2 days" for a plain interval. */
function formatIntervalSeconds(interval: number | string | undefined): string {
  const seconds = typeof interval === "number" ? interval : Number(interval);
  if (!Number.isFinite(seconds) || seconds <= 0) return "on a fixed interval";
  const units: [number, string][] = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds % size === 0 || seconds >= size * 2) {
      const count = Math.round(seconds / size);
      return `every ${count === 1 ? name : `${count} ${name}s`}`;
    }
  }
  return `every ${seconds} seconds`;
}

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

const orphanActions = [
  {
    value: "skip" as const,
    label: "Skip",
    description: "Leave the mirror untouched",
    icon: CircleOff,
    info: "Orphaned mirrors stay exactly as they are and keep their sync settings.",
  },
  {
    value: "archive" as const,
    label: "Archive",
    description: "Kept read-only with an archived prefix",
    icon: Archive,
    info: "Renames the mirror with an archived- prefix and disables automatic syncs. Nothing is lost; use Manual Sync to refresh.",
  },
  {
    value: "delete" as const,
    label: "Delete",
    description: "Remove the mirror from Gitea",
    icon: Trash2,
    info: "Permanently deletes the mirror repository from Gitea.",
  },
];

export function AutomationSettings({
  scheduleConfig,
  cleanupConfig,
  onScheduleChange,
  onCleanupChange,
  isAutoSavingSchedule,
  isAutoSavingCleanup,
}: AutomationSettingsProps) {
  // Re-render timestamps when the user changes the 12h/24h preference.
  useTimeFormat();

  const browserTimezone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      : "UTC";

  // The timezone the scheduler really uses. It used to be shown as the
  // browser timezone whenever UTC was stored, which made the card promise a
  // local 22:00 while the sync ran at 22:00 UTC (#427). The chip below offers
  // a one-click switch to the browser timezone when the two differ.
  const effectiveTimezone = scheduleConfig.timezone || browserTimezone;
  const timezoneDiffers = effectiveTimezone !== browserTimezone;

  // The stored schedule is a plain interval (seconds or a duration such as
  // 8h) rather than a clock schedule. That is what SCHEDULE_INTERVAL and
  // GITEA_MIRROR_INTERVAL produce, and what older versions stored. The card
  // only edits clock schedules, so say what actually runs instead of showing
  // the 22:00 placeholder as if it were saved (#427).
  const isIntervalSchedule = scheduleConfig.scheduleMode === "interval";

  const nextScheduledRun = useMemo(() => {
    if (!scheduleConfig.enabled || isIntervalSchedule) return null;
    const startTime = scheduleConfig.startTime || "22:00";
    const frequencyHours = scheduleConfig.clockFrequencyHours || 24;
    const cronExpression = buildClockCronExpression(startTime, frequencyHours);
    if (!cronExpression) return null;
    try {
      return getNextCronOccurrence(cronExpression, new Date(), effectiveTimezone);
    } catch {
      return null;
    }
  }, [scheduleConfig.enabled, isIntervalSchedule, scheduleConfig.startTime, scheduleConfig.clockFrequencyHours, effectiveTimezone]);

  const switchToBrowserTimezone = () =>
    onScheduleChange({
      ...scheduleConfig,
      scheduleMode: "clock",
      startTime: scheduleConfig.startTime || "22:00",
      clockFrequencyHours: scheduleConfig.clockFrequencyHours || 24,
      timezone: browserTimezone,
    });

  // Update nextRun for cleanup when settings change
  useEffect(() => {
    if (cleanupConfig.enabled && !cleanupConfig.nextRun) {
      const cleanupInterval = getCleanupInterval(cleanupConfig.retentionDays);
      const nextRun = new Date(Date.now() + cleanupInterval * 1000);
      onCleanupChange({ ...cleanupConfig, nextRun });
    }
  }, [cleanupConfig.enabled, cleanupConfig.retentionDays]);

  const savingSpinner = (saving?: boolean) =>
    saving ? (
      <Activity className="h-4 w-4 animate-spin text-muted-foreground" />
    ) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2">
        {/* Automatic Syncing */}
        <SettingsCard
          icon={RefreshCw}
          title="Automatic Syncing"
          enabled={scheduleConfig.enabled}
          onEnabledChange={(checked) =>
            onScheduleChange({
              ...scheduleConfig,
              enabled: checked,
              timezone: checked ? browserTimezone : scheduleConfig.timezone,
              startTime: scheduleConfig.startTime || "22:00",
              clockFrequencyHours: scheduleConfig.clockFrequencyHours || 24,
              scheduleMode: "clock",
            })
          }
          headerAction={savingSpinner(isAutoSavingSchedule)}
          footer={
            <>
              <StatusFooterItem
                icon={History}
                label="Last sync"
                value={
                  scheduleConfig.lastRun
                    ? formatDate(scheduleConfig.lastRun)
                    : "Never"
                }
              />
              {scheduleConfig.enabled ? (
                <StatusFooterItem
                  icon={Calendar}
                  label="Next sync"
                  value={
                    scheduleConfig.nextRun
                      ? formatDate(scheduleConfig.nextRun)
                      : nextScheduledRun
                        ? formatDate(nextScheduledRun)
                        : "Calculating..."
                  }
                  valueClassName="text-indigo-500"
                />
              ) : (
                <span className="text-xs text-muted-foreground/70">
                  Enable syncing to schedule updates
                </span>
              )}
            </>
          }
        >
          {scheduleConfig.enabled && (
            <>
              <CardSection>
                <SectionTitle
                  action={
                    timezoneDiffers ? (
                      <button
                        type="button"
                        onClick={switchToBrowserTimezone}
                        title={`Switch the schedule to ${browserTimezone}`}
                        className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                      >
                        <Globe className="h-3 w-3" />
                        {effectiveTimezone}
                        <span className="text-muted-foreground/60">· use {browserTimezone}</span>
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
                        <Globe className="h-3 w-3" />
                        {effectiveTimezone}
                      </span>
                    )
                  }
                >
                  Schedule
                </SectionTitle>

                {isIntervalSchedule && (
                  <p className="flex items-start gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Syncing {formatIntervalSeconds(scheduleConfig.interval)}, counted from the last run.
                      {" "}This interval comes from SCHEDULE_INTERVAL or GITEA_MIRROR_INTERVAL, which is applied again on every restart while it is set, or from an older version.
                      {" "}Pick a frequency or start time to switch to a clock schedule.
                    </span>
                  </p>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="clock-frequency"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Frequency
                    </Label>
                    <Select
                      value={isIntervalSchedule ? "" : String(scheduleConfig.clockFrequencyHours || 24)}
                      onValueChange={(value) =>
                        onScheduleChange({
                          ...scheduleConfig,
                          scheduleMode: "clock",
                          clockFrequencyHours: parseInt(value, 10),
                          startTime: scheduleConfig.startTime || "22:00",
                          timezone: effectiveTimezone,
                        })
                      }
                    >
                      <SelectTrigger id="clock-frequency" className="w-full">
                        <SelectValue placeholder="Choose a frequency" />
                      </SelectTrigger>
                      <SelectContent>
                        {clockFrequencies.map((option) => (
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

                  <div className="space-y-1.5">
                    <Label
                      htmlFor="clock-start-time"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Start time
                    </Label>
                    <div className="relative">
                      <div className="text-muted-foreground pointer-events-none absolute inset-y-0 left-0 flex items-center justify-center pl-3">
                        <Clock className="size-4" />
                      </div>
                      <Input
                        id="clock-start-time"
                        type="time"
                        value={isIntervalSchedule ? "" : scheduleConfig.startTime || "22:00"}
                        onChange={(event) =>
                          onScheduleChange({
                            ...scheduleConfig,
                            scheduleMode: "clock",
                            startTime: event.target.value,
                            clockFrequencyHours:
                              scheduleConfig.clockFrequencyHours || 24,
                            timezone: effectiveTimezone,
                          })
                        }
                        className="appearance-none pl-9 dark:bg-input/30 [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                      />
                    </div>
                  </div>
                </div>
              </CardSection>
              <CardDivider />
              <CardSection>
                <SwitchRow
                  label="Auto-mirror new repositories"
                  description="Mirror repos discovered during sync automatically"
                  info="When off, newly discovered repos are imported for browsing and wait for a manual mirror click. Starred repos have their own toggle in GitHub settings."
                  checked={scheduleConfig.autoMirror ?? false}
                  onCheckedChange={(checked) =>
                    onScheduleChange({ ...scheduleConfig, autoMirror: checked })
                  }
                />
              </CardSection>
            </>
          )}
        </SettingsCard>

        {/* Database Maintenance */}
        <SettingsCard
          icon={Database}
          title="Database Maintenance"
          enabled={cleanupConfig.enabled}
          onEnabledChange={(checked) =>
            onCleanupChange({ ...cleanupConfig, enabled: checked })
          }
          headerAction={savingSpinner(isAutoSavingCleanup)}
          className="md:h-full"
          footer={
            <>
              <StatusFooterItem
                icon={History}
                label="Last run"
                value={
                  cleanupConfig.lastRun
                    ? formatDate(cleanupConfig.lastRun)
                    : "Never"
                }
              />
              {cleanupConfig.enabled && cleanupConfig.nextRun ? (
                <StatusFooterItem
                  icon={Calendar}
                  label="Next run"
                  value={formatDate(cleanupConfig.nextRun)}
                  valueClassName="text-indigo-500"
                />
              ) : (
                <span className="text-xs text-muted-foreground/70">
                  Old activity logs are removed automatically
                </span>
              )}
            </>
          }
        >
          {cleanupConfig.enabled && (
            <CardSection>
              <SectionTitle>Data retention</SectionTitle>
              <div className="flex items-center gap-3">
                <Select
                  value={cleanupConfig.retentionDays.toString()}
                  onValueChange={(value) =>
                    onCleanupChange({
                      ...cleanupConfig,
                      retentionDays: parseInt(value, 10),
                    })
                  }
                >
                  <SelectTrigger id="retention-period" className="w-40">
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
                <p className="text-xs text-muted-foreground">
                  Cleanup runs {getCleanupFrequencyText(cleanupConfig.retentionDays)}
                </p>
              </div>
              <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
                Activity logs and events older than the retention period are
                removed. Cleanup frequency adapts to the period you pick.
              </p>
            </CardSection>
          )}
        </SettingsCard>
      </div>

      {/* Repository Cleanup */}
      <SettingsCard
        icon={ArchiveRestore}
        title="Repository Cleanup"
        enabled={Boolean(cleanupConfig.deleteIfNotInGitHub)}
        onEnabledChange={(checked) =>
          onCleanupChange({ ...cleanupConfig, deleteIfNotInGitHub: checked })
        }
        headerAction={savingSpinner(isAutoSavingCleanup)}
        footer={
          <>
            <StatusFooterItem
              icon={Info}
              label="Runs as part of each scheduled sync"
            />
            <ReconcileDestinationButton />
          </>
        }
      >
        {cleanupConfig.deleteIfNotInGitHub && (
          <>
            <CardSection>
              <SectionTitle>When a GitHub repo is deleted</SectionTitle>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {orphanActions.map((action) => (
                  <OptionTile
                    key={action.value}
                    icon={action.icon}
                    label={action.label}
                    description={action.description}
                    info={action.info}
                    selected={
                      (cleanupConfig.orphanedRepoAction ?? "archive") ===
                      action.value
                    }
                    onSelect={() =>
                      onCleanupChange({
                        ...cleanupConfig,
                        orphanedRepoAction: action.value,
                      })
                    }
                  />
                ))}
              </div>
            </CardSection>
            <CardDivider />
            <CardSection>
              <SwitchRow
                label="Dry run"
                description="Log planned actions without changing anything"
                checked={Boolean(cleanupConfig.dryRun)}
                onCheckedChange={(checked) =>
                  onCleanupChange({ ...cleanupConfig, dryRun: checked })
                }
              />
            </CardSection>
          </>
        )}
      </SettingsCard>
    </div>
  );
}
