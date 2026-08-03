import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Bell, Activity, Send, Info } from "lucide-react";
import { toast } from "sonner";
import type { NotificationConfig } from "@/types/config";
import { withBase } from "@/lib/base-path";
import {
  SettingsCard,
  SectionTitle,
  SwitchRow,
  SegmentedControl,
  StatusFooterItem,
  CardDivider,
  CardSection,
} from "./settings-ui";

interface NotificationSettingsProps {
  notificationConfig: NotificationConfig;
  onNotificationChange: (config: NotificationConfig) => void;
  isAutoSaving?: boolean;
}

type Provider = "ntfy" | "apprise" | "gotify" | "webhook";

const providerOptions: { value: Provider; label: string }[] = [
  { value: "ntfy", label: "Ntfy.sh" },
  { value: "apprise", label: "Apprise" },
  { value: "gotify", label: "Gotify" },
  { value: "webhook", label: "Webhook" },
];

function Field({
  id,
  label,
  required,
  helper,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
      {helper && (
        <p className="text-[11px] text-muted-foreground/80">{helper}</p>
      )}
    </div>
  );
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
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <SettingsCard
        icon={Bell}
        title="Notifications"
        enabled={notificationConfig.enabled}
        onEnabledChange={(checked) =>
          onNotificationChange({ ...notificationConfig, enabled: checked })
        }
        headerAction={
          isAutoSaving ? (
            <Activity className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : undefined
        }
        footer={
          notificationConfig.enabled ? (
            <>
              <StatusFooterItem
                icon={Info}
                label="Sends a test message with your current settings"
              />
              <Button
                size="sm"
                onClick={handleTestNotification}
                disabled={isTesting}
                className="bg-indigo-500 text-white hover:bg-indigo-600"
              >
                {isTesting ? (
                  <>
                    <Activity className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-3.5 w-3.5" />
                    Send test
                  </>
                )}
              </Button>
            </>
          ) : (
            <StatusFooterItem
              icon={Info}
              label="Get alerted when mirror jobs complete or fail"
            />
          )
        }
      >
        {notificationConfig.enabled && (
          <CardSection>
            <SectionTitle>Provider</SectionTitle>
            <SegmentedControl
              options={providerOptions}
              value={notificationConfig.provider}
              onChange={(value) =>
                onNotificationChange({ ...notificationConfig, provider: value })
              }
            />

            {notificationConfig.provider === "ntfy" && (
              <div className="space-y-4 pt-2">
                <Field
                  id="ntfy-url"
                  label="Server URL"
                  helper="Use https://ntfy.sh for the public server or your self-hosted instance URL"
                >
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
                </Field>
                <Field
                  id="ntfy-topic"
                  label="Topic"
                  required
                  helper="Choose a unique topic name. Anyone with the topic name can subscribe."
                >
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
                </Field>
                <Field
                  id="ntfy-token"
                  label="Access token (optional)"
                  helper="Required if your ntfy server uses authentication"
                >
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
                </Field>
                <Field
                  id="ntfy-priority"
                  label="Default priority"
                  helper='Error notifications always use "high" priority regardless of this setting'
                >
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
                </Field>
              </div>
            )}

            {notificationConfig.provider === "apprise" && (
              <div className="space-y-4 pt-2">
                <Field
                  id="apprise-url"
                  label="Server URL"
                  required
                  helper="URL of your Apprise API server (e.g., http://apprise:8000)"
                >
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
                </Field>
                <Field
                  id="apprise-token"
                  label="Token / path"
                  required
                  helper="The Apprise API configuration token or key"
                >
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
                </Field>
                <Field
                  id="apprise-tag"
                  label="Tag filter (optional)"
                  helper="Optional tag to filter which Apprise services receive notifications"
                >
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
                </Field>
              </div>
            )}

            {notificationConfig.provider === "gotify" && (
              <div className="space-y-4 pt-2">
                <Field
                  id="gotify-url"
                  label="Server URL"
                  required
                  helper="URL of your Gotify server"
                >
                  <Input
                    id="gotify-url"
                    type="url"
                    placeholder="https://gotify.example.com"
                    value={notificationConfig.gotify?.url || ""}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        gotify: {
                          ...notificationConfig.gotify!,
                          url: e.target.value,
                          token: notificationConfig.gotify?.token || "",
                          priority: notificationConfig.gotify?.priority ?? 5,
                        },
                      })
                    }
                  />
                </Field>
                <Field
                  id="gotify-token"
                  label="Application token"
                  required
                  helper="Create an application in Gotify and paste its token here"
                >
                  <Input
                    id="gotify-token"
                    type="password"
                    placeholder="A1b2C3d4..."
                    value={notificationConfig.gotify?.token || ""}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        gotify: {
                          ...notificationConfig.gotify!,
                          url: notificationConfig.gotify?.url || "",
                          token: e.target.value,
                          priority: notificationConfig.gotify?.priority ?? 5,
                        },
                      })
                    }
                  />
                </Field>
                <Field
                  id="gotify-priority"
                  label="Default priority (0-10)"
                  helper="Error notifications always use priority 8 regardless of this setting"
                >
                  <Input
                    id="gotify-priority"
                    type="number"
                    min={0}
                    max={10}
                    value={notificationConfig.gotify?.priority ?? 5}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        gotify: {
                          ...notificationConfig.gotify!,
                          url: notificationConfig.gotify?.url || "",
                          token: notificationConfig.gotify?.token || "",
                          priority: Math.min(10, Math.max(0, Number(e.target.value) || 0)),
                        },
                      })
                    }
                  />
                </Field>
              </div>
            )}

            {notificationConfig.provider === "webhook" && (
              <div className="space-y-4 pt-2">
                <Field
                  id="webhook-url"
                  label="Webhook URL"
                  required
                  helper="Notifications are sent as a JSON POST with title, message, type, and timestamp fields"
                >
                  <Input
                    id="webhook-url"
                    type="url"
                    placeholder="https://example.com/hooks/gitea-mirror"
                    value={notificationConfig.webhook?.url || ""}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        webhook: {
                          ...notificationConfig.webhook,
                          url: e.target.value,
                        },
                      })
                    }
                  />
                </Field>
                <Field
                  id="webhook-secret"
                  label="Signing secret (optional)"
                  helper="If set, requests include an X-Webhook-Signature header with an HMAC-SHA256 hex digest of the body (sha256=...)"
                >
                  <Input
                    id="webhook-secret"
                    type="password"
                    placeholder="whsec_..."
                    value={notificationConfig.webhook?.secret || ""}
                    onChange={(e) =>
                      onNotificationChange({
                        ...notificationConfig,
                        webhook: {
                          ...notificationConfig.webhook,
                          url: notificationConfig.webhook?.url || "",
                          secret: e.target.value,
                        },
                      })
                    }
                  />
                </Field>
              </div>
            )}
          </CardSection>
        )}
      </SettingsCard>

      {notificationConfig.enabled && (
        <SettingsCard
          icon={Activity}
          title="Notification Events"
          footer={
            <StatusFooterItem
              icon={Info}
              label="Error notifications are always sent at high priority"
            />
          }
        >
          <CardSection>
            <SwitchRow
              label="Sync errors"
              description="Notify when a mirror job fails"
              checked={notificationConfig.notifyOnSyncError}
              onCheckedChange={(checked) =>
                onNotificationChange({
                  ...notificationConfig,
                  notifyOnSyncError: checked,
                })
              }
            />
          </CardSection>
          <CardDivider />
          <CardSection>
            <SwitchRow
              label="Sync success"
              description="Notify when a mirror job completes successfully"
              checked={notificationConfig.notifyOnSyncSuccess}
              onCheckedChange={(checked) =>
                onNotificationChange({
                  ...notificationConfig,
                  notifyOnSyncSuccess: checked,
                })
              }
            />
          </CardSection>
          <CardDivider />
          <CardSection>
            <SwitchRow
              label="New repository discovered"
              description="Notify when a new GitHub repository is auto-imported"
              badge="SOON"
              checked={notificationConfig.notifyOnNewRepo}
              disabled
              onCheckedChange={(checked) =>
                onNotificationChange({
                  ...notificationConfig,
                  notifyOnNewRepo: checked,
                })
              }
            />
          </CardSection>
        </SettingsCard>
      )}
    </div>
  );
}
