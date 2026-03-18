import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock fetch globally before importing the module
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
  mockFetch = mock(() =>
    Promise.resolve(new Response("ok", { status: 200 }))
  );
  globalThis.fetch = mockFetch as any;
});

// Mock encryption module
mock.module("@/lib/utils/encryption", () => ({
  encrypt: (val: string) => val,
  decrypt: (val: string) => val,
  isEncrypted: () => false,
}));

// Import after mocks are set up — db is already mocked via setup.bun.ts
import { sendNotification, testNotification } from "./notification-service";
import type { NotificationConfig } from "@/types/config";

describe("sendNotification", () => {
  test("sends ntfy notification when provider is ntfy", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "ntfy",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      ntfy: {
        url: "https://ntfy.sh",
        topic: "test-topic",
        priority: "default",
      },
    };

    await sendNotification(config, {
      title: "Test",
      message: "Test message",
      type: "sync_success",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ntfy.sh/test-topic");
  });

  test("sends apprise notification when provider is apprise", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "apprise",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      apprise: {
        url: "http://apprise:8000",
        token: "my-token",
      },
    };

    await sendNotification(config, {
      title: "Test",
      message: "Test message",
      type: "sync_success",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://apprise:8000/notify/my-token");
  });

  test("does not throw when fetch fails", async () => {
    mockFetch = mock(() => Promise.reject(new Error("Network error")));
    globalThis.fetch = mockFetch as any;

    const config: NotificationConfig = {
      enabled: true,
      provider: "ntfy",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      ntfy: {
        url: "https://ntfy.sh",
        topic: "test-topic",
        priority: "default",
      },
    };

    // Should not throw
    await sendNotification(config, {
      title: "Test",
      message: "Test message",
      type: "sync_success",
    });
  });

  test("skips notification when ntfy topic is missing", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "ntfy",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      ntfy: {
        url: "https://ntfy.sh",
        topic: "",
        priority: "default",
      },
    };

    await sendNotification(config, {
      title: "Test",
      message: "Test message",
      type: "sync_success",
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("skips notification when apprise URL is missing", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "apprise",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      apprise: {
        url: "",
        token: "my-token",
      },
    };

    await sendNotification(config, {
      title: "Test",
      message: "Test message",
      type: "sync_success",
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("testNotification", () => {
  test("returns success when notification is sent", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "ntfy",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      ntfy: {
        url: "https://ntfy.sh",
        topic: "test-topic",
        priority: "default",
      },
    };

    const result = await testNotification(config);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("returns error when topic is missing", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "ntfy",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      ntfy: {
        url: "https://ntfy.sh",
        topic: "",
        priority: "default",
      },
    };

    const result = await testNotification(config);
    expect(result.success).toBe(false);
    expect(result.error).toContain("topic");
  });

  test("returns error when fetch fails", async () => {
    mockFetch = mock(() =>
      Promise.resolve(new Response("bad request", { status: 400 }))
    );
    globalThis.fetch = mockFetch as any;

    const config: NotificationConfig = {
      enabled: true,
      provider: "ntfy",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      ntfy: {
        url: "https://ntfy.sh",
        topic: "test-topic",
        priority: "default",
      },
    };

    const result = await testNotification(config);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns error for unknown provider", async () => {
    const config = {
      enabled: true,
      provider: "unknown" as any,
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
    };

    const result = await testNotification(config);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown provider");
  });
});
