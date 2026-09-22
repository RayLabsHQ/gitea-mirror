import type { AppriseConfig } from "@/types/config";
import { safeFetch } from "@/lib/utils/outbound-url";
import type { NotificationEvent } from "./ntfy";

export async function sendAppriseNotification(config: AppriseConfig, event: NotificationEvent): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/notify/${config.token}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body = JSON.stringify({
    title: event.title,
    body: event.message,
    type: event.type === "sync_error" ? "failure" : "success",
    tag: config.tag || undefined,
  });
  const resp = await safeFetch(url, { method: "POST", body, headers });
  if (!resp.ok) throw new Error(`Apprise error: ${resp.status}`);
}
