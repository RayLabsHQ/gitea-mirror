import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Bell, Activity, Send } from "lucide-react";
import { toast } from "sonner";
import type { NotificationConfig } from "@/types/config";
import { withBase } from "@/lib/base-path";

interface NotificationSettingsProps {
  notificationConfig: NotificationConfig;
  onNotificationChange: (config: NotificationConfig) => void;
  isAutoSaving?: boolean;
}

export function NotificationSettings({
  notificationConfig,
  onNotificationChange,
  isAutoSaving,
}: NotificationSettingsProps) {
  const [isTesting, setIsTesting] = useState(false);

  const handleTestNotification = async () => {
    setIsTesting(true);
    try {
      const resp = await fetch(withBase("/api/notifications/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationConfig }),
      });
      const result = await resp.json();
      if (result.success) {
        toast.success("Test notification sent successfully!");
      } else {
        toast.error(`Test failed: ${result.error || "Unknown error"}`);
      }
    } catch (error) {
      toast.error(
        `Test failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Notifications
          {isAutoSaving && (
            <Activity className="h-4 w-4 animate-spin text-muted-foreground ml-2" />
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Enable/disable toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="notifications-enabled" className="text-sm font-medium cursor-pointer">
              Enable notifications
            </Label>
            <p className="text-xs text-muted-foreground">
              Receive alerts when mirror jobs complete or fail
            </p>
          </div>
          <Switch
            id="notifications-enabled"
            checked={notificationConfig.enabled}
            onCheckedChange={(checked) =>
              onNotificationChange({ ...notificationConfig, enabled: checked })
            }
          />
        </div>

        {notificationConfig.enabled && (
          <>
            {/* Provider selector */}
            <div className="space-y-2">
              <Label htmlFor="notification-provider" className="text-sm font-medium">
                Notification provider
              </Label>
              <Select
                value={notificationConfig.provider}
                onValueChange={(value: "ntfy" | "apprise") =>
                  onNotificationChange({ ...notificationConfig, provider: value })
                }
              >
                <SelectTrigger id="notification-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ntfy">Ntfy.sh</SelectItem>
                  <SelectItem value="apprise">Apprise API</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Ntfy configuration */}
            {notificationConfig.provider === "ntfy" && (
              <div className="space-y-4 p-4 border border-border rounded-lg bg-card/50">
                <h3 className="text-sm font-medium">Ntfy.sh Settings</h3>

                <div className="space-y-2">
                  <Label htmlFor="ntfy-url" className="text-sm">
                    Server URL
                  </Label>
                  <Input
                    id="ntfy-url"
                    type="url"
                    placeholder="https://ntfy.sh"
                    value={notificationConfig.ntfy?.url || "https://ntfy.sh"}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        ntfy: {
                          ...notificationConfig.ntfy!,
                          url: e.target.value,
                          topic: notificationConfig.ntfy?.topic || "",
                          priority: notificationConfig.ntfy?.priority || "default",
                        },
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Use https://ntfy.sh for the public server or your self-hosted instance URL
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ntfy-topic" className="text-sm">
                    Topic <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="ntfy-topic"
                    placeholder="gitea-mirror"
                    value={notificationConfig.ntfy?.topic || ""}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        ntfy: {
                          ...notificationConfig.ntfy!,
                          url: notificationConfig.ntfy?.url || "https://ntfy.sh",
                          topic: e.target.value,
                          priority: notificationConfig.ntfy?.priority || "default",
                        },
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Choose a unique topic name. Anyone with the topic name can subscribe.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ntfy-token" className="text-sm">
                    Access token (optional)
                  </Label>
                  <Input
                    id="ntfy-token"
                    type="password"
                    placeholder="tk_..."
                    value={notificationConfig.ntfy?.token || ""}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        ntfy: {
                          ...notificationConfig.ntfy!,
                          url: notificationConfig.ntfy?.url || "https://ntfy.sh",
                          topic: notificationConfig.ntfy?.topic || "",
                          token: e.target.value,
                          priority: notificationConfig.ntfy?.priority || "default",
                        },
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Required if your ntfy server uses authentication
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ntfy-priority" className="text-sm">
                    Default priority
                  </Label>
                  <Select
                    value={notificationConfig.ntfy?.priority || "default"}
                    onValueChange={(value: "min" | "low" | "default" | "high" | "urgent") =>
                      onNotificationChange({
                        ...notificationConfig,
                        ntfy: {
                          ...notificationConfig.ntfy!,
                          url: notificationConfig.ntfy?.url || "https://ntfy.sh",
                          topic: notificationConfig.ntfy?.topic || "",
                          priority: value,
                        },
                      })
                    }
                  >
                    <SelectTrigger id="ntfy-priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="min">Min</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="default">Default</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Error notifications always use "high" priority regardless of this setting
                  </p>
                </div>
              </div>
            )}

            {/* Apprise configuration */}
            {notificationConfig.provider === "apprise" && (
              <div className="space-y-4 p-4 border border-border rounded-lg bg-card/50">
                <h3 className="text-sm font-medium">Apprise API Settings</h3>

                <div className="space-y-2">
                  <Label htmlFor="apprise-url" className="text-sm">
                    Server URL <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="apprise-url"
                    type="url"
                    placeholder="http://apprise:8000"
                    value={notificationConfig.apprise?.url || ""}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        apprise: {
                          ...notificationConfig.apprise!,
                          url: e.target.value,
                          token: notificationConfig.apprise?.token || "",
                        },
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    URL of your Apprise API server (e.g., http://apprise:8000)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="apprise-token" className="text-sm">
                    Token / path <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="apprise-token"
                    placeholder="gitea-mirror"
                    value={notificationConfig.apprise?.token || ""}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        apprise: {
                          ...notificationConfig.apprise!,
                          url: notificationConfig.apprise?.url || "",
                          token: e.target.value,
                        },
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    The Apprise API configuration token or key
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="apprise-tag" className="text-sm">
                    Tag filter (optional)
                  </Label>
                  <Input
                    id="apprise-tag"
                    placeholder="all"
                    value={notificationConfig.apprise?.tag || ""}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        apprise: {
                          ...notificationConfig.apprise!,
                          url: notificationConfig.apprise?.url || "",
                          token: notificationConfig.apprise?.token || "",
                          tag: e.target.value,
                        },
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional tag to filter which Apprise services receive notifications
                  </p>
                </div>
              </div>
            )}

            {/* Event toggles */}
            <div className="space-y-4 p-4 border border-border rounded-lg bg-card/50">
              <h3 className="text-sm font-medium">Notification Events</h3>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="notify-sync-error" className="text-sm font-normal cursor-pointer">
                    Sync errors
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Notify when a mirror job fails
                  </p>
                </div>
                <Switch
                  id="notify-sync-error"
                  checked={notificationConfig.notifyOnSyncError}
                  onCheckedChange={(checked) =>
                    onNotificationChange({ ...notificationConfig, notifyOnSyncError: checked })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="notify-sync-success" className="text-sm font-normal cursor-pointer">
                    Sync success
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Notify when a mirror job completes successfully
                  </p>
                </div>
                <Switch
                  id="notify-sync-success"
                  checked={notificationConfig.notifyOnSyncSuccess}
                  onCheckedChange={(checked) =>
                    onNotificationChange({ ...notificationConfig, notifyOnSyncSuccess: checked })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="notify-new-repo" className="text-sm font-normal cursor-pointer text-muted-foreground">
                    New repository discovered (coming soon)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Notify when a new GitHub repository is auto-imported
                  </p>
                </div>
                <Switch
                  id="notify-new-repo"
                  checked={notificationConfig.notifyOnNewRepo}
                  disabled
                  onCheckedChange={(checked) =>
                    onNotificationChange({ ...notificationConfig, notifyOnNewRepo: checked })
                  }
                />
              </div>
            </div>

            {/* Test button */}
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={handleTestNotification}
                disabled={isTesting}
              >
                {isTesting ? (
                  <>
                    <Activity className="h-4 w-4 animate-spin mr-2" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Send Test Notification
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
