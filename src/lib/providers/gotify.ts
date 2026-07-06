import type { GotifyConfig } from "@/types/config";
import type { NotificationEvent } from "./ntfy";

export async function sendGotifyNotification(config: GotifyConfig, event: NotificationEvent): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/message`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Gotify-Key": config.token,
  };
  const body = JSON.stringify({
    title: event.title,
    message: event.message,
    priority: event.type === "sync_error" ? 8 : (config.priority ?? 5),
  });
  const resp = await fetch(url, { method: "POST", body, headers });
  if (!resp.ok) throw new Error(`Gotify error: ${resp.status} ${await resp.text()}`);
}
