import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "../ui/checkbox";
import type { ScheduleConfig } from "@/types/config";
import { formatDate } from "@/lib/utils";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { RefreshCw } from "lucide-react";

interface ScheduleConfigFormProps {
  config: ScheduleConfig;
  setConfig: React.Dispatch<React.SetStateAction<ScheduleConfig>>;
  onAutoSave?: (config: ScheduleConfig) => void;
  isAutoSaving?: boolean;
}

export function ScheduleConfigForm({
  config,
  setConfig,
  onAutoSave,
  isAutoSaving = false,
}: ScheduleConfigFormProps) {
  // Re-render timestamps when the user changes the 12h/24h preference.
  useTimeFormat();

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    const newConfig = {
      ...config,
      [name]:
        type === "checkbox" ? (e.target as HTMLInputElement).checked : value,
    };
    setConfig(newConfig);

    // Trigger auto-save for schedule config changes
    if (onAutoSave) {
      onAutoSave(newConfig);
    }
  };

  // Predefined intervals
  const intervals: { value: number; label: string }[] = [
    { value: 3600, label: "1 hour" },
    { value: 7200, label: "2 hours" },
    { value: 14400, label: "4 hours" },
    { value: 28800, label: "8 hours" },
    { value: 43200, label: "12 hours" },
    { value: 86400, label: "1 day" },
    { value: 172800, label: "2 days" },
    { value: 604800, label: "1 week" },
  ];

  return (
    <Card className="self-start">
      <CardContent className="pt-6 relative">
        {isAutoSaving && (
          <div className="absolute top-4 right-4 flex items-center text-sm text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin mr-1" />
            <span className="text-xs">Auto-saving...</span>
          </div>
        )}
        <div className="flex flex-col gap-y-4">
          <div className="flex items-center">
            <Checkbox
              id="enabled"
              name="enabled"
              checked={config.enabled}
              onCheckedChange={(checked) =>
                handleChange({
                  target: {
                    name: "enabled",
                    type: "checkbox",
                    checked: Boolean(checked),
                    value: "",
                  },
                } as React.ChangeEvent<HTMLInputElement>)
              }
            />
            <label
              htmlFor="enabled"
              className="select-none ml-2 block text-sm font-medium"
            >
              Enable Automatic Syncing
            </label>
          </div>

          {config.enabled && (
            <div>
              <label
                htmlFor="interval"
                className="block text-sm font-medium mb-1.5"
              >
                Sync Interval
              </label>

              <Select
                name="interval"
                value={String(config.interval)}
                onValueChange={(value) =>
                  handleChange({
                    target: { name: "interval", value },
                  } as React.ChangeEvent<HTMLInputElement>)
                }
              >
                <SelectTrigger className="w-full border border-input dark:bg-background dark:hover:bg-background">
                  <SelectValue placeholder="Select interval" />
                </SelectTrigger>
                <SelectContent className="bg-background text-foreground border border-input shadow-sm">
                  {intervals.map((interval) => (
                    <SelectItem
                      key={interval.value}
                      value={interval.value.toString()}
                      className="cursor-pointer text-sm px-3 py-2 hover:bg-accent focus:bg-accent focus:text-accent-foreground"
                    >
                      {interval.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <p className="text-xs text-muted-foreground mt-1">
                How often the sync process should run.
              </p>
              <div className="mt-2 p-2 bg-muted/50 rounded-md">
                <p className="text-xs text-muted-foreground">
                  <strong>Sync Schedule:</strong> Repositories will be synchronized at the specified interval.
                  Choose shorter intervals for frequently updated repositories, longer intervals for stable ones.
                </p>
              </div>
            </div>
          )}

          <div className="flex gap-x-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Last Sync</label>
              <div className="text-sm">
                {config.lastRun ? formatDate(config.lastRun) : "Never"}
              </div>
            </div>

            {config.enabled && (
              <div className="flex-1">
                <label className="block text-sm font-medium mb-1">Next Sync</label>
                <div className="text-sm">
                  {config.nextRun ? formatDate(config.nextRun) : "Never"}
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
