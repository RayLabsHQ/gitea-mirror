import { describe, test, expect, beforeEach, mock } from "bun:test";
import { sendNtfyNotification, type NotificationEvent } from "./ntfy";
import type { NtfyConfig } from "@/types/config";

describe("sendNtfyNotification", () => {
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    );
    globalThis.fetch = mockFetch as any;
  });

  const baseConfig: NtfyConfig = {
    url: "https://ntfy.sh",
    topic: "gitea-mirror",
    priority: "default",
  };

  const baseEvent: NotificationEvent = {
    title: "Test Notification",
    message: "This is a test",
    type: "sync_success",
  };

  test("constructs correct URL from config", async () => {
    await sendNtfyNotification(baseConfig, baseEvent);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ntfy.sh/gitea-mirror");
  });

  test("strips trailing slash from URL", async () => {
    await sendNtfyNotification(
      { ...baseConfig, url: "https://ntfy.sh/" },
      baseEvent
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ntfy.sh/gitea-mirror");
  });

  test("includes Authorization header when token is present", async () => {
    await sendNtfyNotification(
      { ...baseConfig, token: "tk_secret" },
      baseEvent
    );

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Authorization"]).toBe("Bearer tk_secret");
  });

  test("does not include Authorization header when no token", async () => {
    await sendNtfyNotification(baseConfig, baseEvent);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Authorization"]).toBeUndefined();
  });

  test("uses high priority for sync_error events", async () => {
    const errorEvent: NotificationEvent = {
      ...baseEvent,
      type: "sync_error",
    };
    await sendNtfyNotification(baseConfig, errorEvent);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Priority"]).toBe("high");
    expect(opts.headers["Tags"]).toBe("warning");
  });

  test("uses config priority for non-error events", async () => {
    await sendNtfyNotification(
      { ...baseConfig, priority: "low" },
      baseEvent
    );

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Priority"]).toBe("low");
    expect(opts.headers["Tags"]).toBe("white_check_mark");
  });

  test("throws on non-200 response", async () => {
    mockFetch = mock(() =>
      Promise.resolve(new Response("rate limited", { status: 429 }))
    );
    globalThis.fetch = mockFetch as any;

    expect(
      sendNtfyNotification(baseConfig, baseEvent)
    ).rejects.toThrow("Ntfy error: 429");
  });
});
