import { describe, test, expect, beforeEach, mock } from "bun:test";
import { sendAppriseNotification } from "./apprise";
import type { NotificationEvent } from "./ntfy";
import type { AppriseConfig } from "@/types/config";

describe("sendAppriseNotification", () => {
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    );
    globalThis.fetch = mockFetch as any;
  });

  const baseConfig: AppriseConfig = {
    url: "http://apprise:8000",
    token: "gitea-mirror",
  };

  const baseEvent: NotificationEvent = {
    title: "Test Notification",
    message: "This is a test",
    type: "sync_success",
  };

  test("constructs correct URL from config", async () => {
    await sendAppriseNotification(baseConfig, baseEvent);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://apprise:8000/notify/gitea-mirror");
  });

  test("strips trailing slash from URL", async () => {
    await sendAppriseNotification(
      { ...baseConfig, url: "http://apprise:8000/" },
      baseEvent
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://apprise:8000/notify/gitea-mirror");
  });

  test("sends correct JSON body format", async () => {
    await sendAppriseNotification(baseConfig, baseEvent);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.title).toBe("Test Notification");
    expect(body.body).toBe("This is a test");
    expect(body.type).toBe("success");
  });

  test("maps sync_error to failure type", async () => {
    const errorEvent: NotificationEvent = {
      ...baseEvent,
      type: "sync_error",
    };
    await sendAppriseNotification(baseConfig, errorEvent);

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.type).toBe("failure");
  });

  test("includes tag when configured", async () => {
    await sendAppriseNotification(
      { ...baseConfig, tag: "urgent" },
      baseEvent
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.tag).toBe("urgent");
  });

  test("omits tag when not configured", async () => {
    await sendAppriseNotification(baseConfig, baseEvent);

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.tag).toBeUndefined();
  });

  test("throws on non-200 response", async () => {
    mockFetch = mock(() =>
      Promise.resolve(new Response("server error", { status: 500 }))
    );
    globalThis.fetch = mockFetch as any;

    expect(
      sendAppriseNotification(baseConfig, baseEvent)
    ).rejects.toThrow("Apprise error: 500");
  });
});
