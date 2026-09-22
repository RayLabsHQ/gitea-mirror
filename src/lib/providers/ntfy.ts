import type { NtfyConfig } from "@/types/config";
import { safeFetch } from "@/lib/utils/outbound-url";

export interface NotificationEvent {
  title: string;
  message: string;
  type: "sync_error" | "sync_success" | "new_repo";
}

export async function sendNtfyNotification(config: NtfyConfig, event: NotificationEvent): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/${config.topic}`;
  const headers: Record<string, string> = {
    "Title": event.title,
    "Priority": event.type === "sync_error" ? "high" : (config.priority || "default"),
    "Tags": event.type === "sync_error" ? "warning" : "white_check_mark",
  };
  if (config.token) {
    headers["Authorization"] = `Bearer ${config.token}`;
  }
  const resp = await safeFetch(url, { method: "POST", body: event.message, headers });
  if (!resp.ok) throw new Error(`Ntfy error: ${resp.status}`);
}
