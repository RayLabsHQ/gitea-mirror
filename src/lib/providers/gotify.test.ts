import { describe, test, expect, beforeEach, mock } from "bun:test";
import { sendGotifyNotification } from "./gotify";
import type { NotificationEvent } from "./ntfy";
import type { GotifyConfig } from "@/types/config";

describe("sendGotifyNotification", () => {
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    );
    globalThis.fetch = mockFetch as any;
  });

  const baseConfig: GotifyConfig = {
    url: "https://gotify.example.com",
    token: "AbCdEf123456",
    priority: 5,
  };

  const baseEvent: NotificationEvent = {
    title: "Test Notification",
    message: "This is a test",
    type: "sync_success",
  };

  test("constructs correct URL from config", async () => {
    await sendGotifyNotification(baseConfig, baseEvent);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://gotify.example.com/message");
  });

  test("strips trailing slash from URL", async () => {
    await sendGotifyNotification(
      { ...baseConfig, url: "https://gotify.example.com/" },
      baseEvent
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://gotify.example.com/message");
  });

  test("sends token via X-Gotify-Key header", async () => {
    await sendGotifyNotification(baseConfig, baseEvent);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["X-Gotify-Key"]).toBe("AbCdEf123456");
  });

  test("sends title and message in JSON body", async () => {
    await sendGotifyNotification(baseConfig, baseEvent);

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.title).toBe("Test Notification");
    expect(body.message).toBe("This is a test");
  });

  test("uses priority 8 for sync_error events", async () => {
    const errorEvent: NotificationEvent = {
      ...baseEvent,
      type: "sync_error",
    };
    await sendGotifyNotification(baseConfig, errorEvent);

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.priority).toBe(8);
  });

  test("uses config priority for non-error events", async () => {
    await sendGotifyNotification(
      { ...baseConfig, priority: 2 },
      baseEvent
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.priority).toBe(2);
  });

  test("defaults to priority 5 when not configured", async () => {
    await sendGotifyNotification(
      { ...baseConfig, priority: undefined as any },
      baseEvent
    );

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.priority).toBe(5);
  });

  test("throws on non-200 response", async () => {
    mockFetch = mock(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 }))
    );
    globalThis.fetch = mockFetch as any;

    expect(
      sendGotifyNotification(baseConfig, baseEvent)
    ).rejects.toThrow("Gotify error: 401");
  });
});
