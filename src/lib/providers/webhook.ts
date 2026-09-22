import { createHmac } from "node:crypto";
import { safeFetch } from "@/lib/utils/outbound-url";
import type { WebhookConfig } from "@/types/config";
import type { NotificationEvent } from "./ntfy";

export async function sendWebhookNotification(config: WebhookConfig, event: NotificationEvent): Promise<void> {
  const body = JSON.stringify({
    title: event.title,
    message: event.message,
    type: event.type,
    timestamp: new Date().toISOString(),
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.secret) {
    const signature = createHmac("sha256", config.secret).update(body).digest("hex");
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }
  const resp = await safeFetch(config.url, { method: "POST", body, headers });
  if (!resp.ok) throw new Error(`Webhook error: ${resp.status}`);
}
