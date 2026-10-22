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
import { sendNotification, testNotification, buildNewRepositoriesNotificationEvent, buildAllReleasesRemovedNotificationEvent, triggerAllReleasesRemovedNotification, isNewRepositoryGroupEnabled, MAX_LISTED_NEW_REPOSITORIES, STARRED_GROUP_LABEL } from "./notification-service";
import type { NotificationConfig } from "@/types/config";

describe("sendNotification", () => {
  test("sends ntfy notification when provider is ntfy", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "ntfy",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
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
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
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

  test("sends gotify notification when provider is gotify", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "gotify",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
      gotify: {
        url: "https://gotify.example.com",
        token: "my-app-token",
        priority: 5,
      },
    };

    await sendNotification(config, {
      title: "Test",
      message: "Test message",
      type: "sync_success",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://gotify.example.com/message");
    expect(opts.headers["X-Gotify-Key"]).toBe("my-app-token");
  });

  test("sends webhook notification when provider is webhook", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "webhook",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
      webhook: {
        url: "https://example.com/hooks/gitea-mirror",
      },
    };

    await sendNotification(config, {
      title: "Test",
      message: "Test message",
      type: "sync_success",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/hooks/gitea-mirror");
    const body = JSON.parse(opts.body);
    expect(body.title).toBe("Test");
    expect(body.type).toBe("sync_success");
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
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
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
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
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
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
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

  test("skips notification when gotify token is missing", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "gotify",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
      gotify: {
        url: "https://gotify.example.com",
        token: "",
        priority: 5,
      },
    };

    await sendNotification(config, {
      title: "Test",
      message: "Test message",
      type: "sync_success",
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("skips notification when webhook URL is missing", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "webhook",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
      webhook: {
        url: "",
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
  test("returns error when webhook URL is missing", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "webhook",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
      webhook: {
        url: "",
      },
    };

    const result = await testNotification(config);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Webhook URL");
  });

  test("returns success when notification is sent", async () => {
    const config: NotificationConfig = {
      enabled: true,
      provider: "ntfy",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: true,
      notifyOnNewRepo: false,
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
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
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
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
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
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
      notifyOnNewOwnRepo: false,
      notifyOnNewOrgRepo: false,
      notifyOnNewStarredRepo: false,
    };

    const result = await testNotification(config);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown provider");
  });
});

describe("buildNewRepositoriesNotificationEvent", () => {
  test("reports the discovered repositories of one owner in a single event", () => {
    const event = buildNewRepositoriesNotificationEvent({
      kind: "organization",
      groupLabel: "gitea",
      repositoryNames: ["gitea/alpha", "gitea/beta"],
      details: "Discovered during scheduled sync on source github.",
    });

    expect(event.type).toBe("new_repo");
    expect(event.title).toBe("New Repositories: gitea");
    expect(event.message).toContain("2 new repositories discovered for gitea:");
    expect(event.message).toContain("- gitea/alpha");
    expect(event.message).toContain("- gitea/beta");
    expect(event.message).toContain("Details: Discovered during scheduled sync on source github.");
  });

  test("uses the singular wording for a single repository", () => {
    const event = buildNewRepositoriesNotificationEvent({
      kind: "own",
      groupLabel: "octocat",
      repositoryNames: ["octocat/alpha"],
    });

    expect(event.message).toContain("1 new repository discovered for octocat:");
    expect(event.message).not.toContain("more");
  });

  test("labels starred imports without naming an owner", () => {
    // Stars come from any number of owners, so they are reported as one group.
    const event = buildNewRepositoriesNotificationEvent({
      kind: "starred",
      repositoryNames: ["alpha/one", "beta/two"],
    });

    expect(event.title).toBe(`New Repositories: ${STARRED_GROUP_LABEL}`);
    expect(event.message).toContain("2 new starred repositories discovered:");
    expect(event.message).not.toContain("for Starred");
  });

  test("caps the listed repositories so a large import stays readable", () => {
    const names = Array.from({ length: MAX_LISTED_NEW_REPOSITORIES + 5 }, (_, i) => `gitea/repo-${i}`);
    const event = buildNewRepositoriesNotificationEvent({
      kind: "organization",
      groupLabel: "gitea",
      repositoryNames: names,
    });

    expect(event.message).toContain("15 new repositories discovered for gitea:");
    expect(event.message).toContain(`- ${names[MAX_LISTED_NEW_REPOSITORIES - 1]}`);
    expect(event.message).not.toContain(names[MAX_LISTED_NEW_REPOSITORIES]);
    expect(event.message).toContain("- and 5 more");
  });

  test("falls back to a placeholder when the group is unknown", () => {
    const event = buildNewRepositoriesNotificationEvent({
      kind: "own",
      repositoryNames: ["someone/repo"],
    });

    expect(event.title).toBe("New Repositories: Unknown");
  });
});

describe("isNewRepositoryGroupEnabled", () => {
  const baseConfig: NotificationConfig = {
    enabled: true,
    provider: "ntfy",
    notifyOnSyncError: true,
    notifyOnSyncSuccess: false,
    notifyOnNewRepo: true,
    notifyOnNewOwnRepo: false,
    notifyOnNewOrgRepo: false,
    notifyOnNewStarredRepo: false,
  };

  test("each group switch enables only its own kind", () => {
    expect(isNewRepositoryGroupEnabled(baseConfig, "own")).toBe(false);
    expect(isNewRepositoryGroupEnabled(baseConfig, "organization")).toBe(false);
    expect(isNewRepositoryGroupEnabled(baseConfig, "starred")).toBe(false);

    expect(isNewRepositoryGroupEnabled({ ...baseConfig, notifyOnNewOwnRepo: true }, "own")).toBe(true);
    expect(isNewRepositoryGroupEnabled({ ...baseConfig, notifyOnNewOwnRepo: true }, "organization")).toBe(false);
    expect(isNewRepositoryGroupEnabled({ ...baseConfig, notifyOnNewOwnRepo: true }, "starred")).toBe(false);

    expect(isNewRepositoryGroupEnabled({ ...baseConfig, notifyOnNewOrgRepo: true }, "organization")).toBe(true);
    expect(isNewRepositoryGroupEnabled({ ...baseConfig, notifyOnNewOrgRepo: true }, "own")).toBe(false);
    expect(isNewRepositoryGroupEnabled({ ...baseConfig, notifyOnNewOrgRepo: true }, "starred")).toBe(false);

    expect(isNewRepositoryGroupEnabled({ ...baseConfig, notifyOnNewStarredRepo: true }, "starred")).toBe(true);
    expect(isNewRepositoryGroupEnabled({ ...baseConfig, notifyOnNewStarredRepo: true }, "own")).toBe(false);
    expect(isNewRepositoryGroupEnabled({ ...baseConfig, notifyOnNewStarredRepo: true }, "organization")).toBe(false);
  });

  test("the master switch gates every group", () => {
    const allGroupsOn: NotificationConfig = {
      ...baseConfig,
      notifyOnNewRepo: false,
      notifyOnNewOwnRepo: true,
      notifyOnNewOrgRepo: true,
      notifyOnNewStarredRepo: true,
    };

    expect(isNewRepositoryGroupEnabled(allGroupsOn, "own")).toBe(false);
    expect(isNewRepositoryGroupEnabled(allGroupsOn, "organization")).toBe(false);
    expect(isNewRepositoryGroupEnabled(allGroupsOn, "starred")).toBe(false);

    const masterOn = { ...allGroupsOn, notifyOnNewRepo: true };
    expect(isNewRepositoryGroupEnabled(masterOn, "own")).toBe(true);
    expect(isNewRepositoryGroupEnabled(masterOn, "organization")).toBe(true);
    expect(isNewRepositoryGroupEnabled(masterOn, "starred")).toBe(true);

    // The provider-wide switch still wins over both discovery switches.
    expect(isNewRepositoryGroupEnabled({ ...masterOn, enabled: false }, "own")).toBe(false);
  });

  test("a stored row without the group switches keeps every group on", () => {
    // Rows saved before the sub-options existed carry the master switch only; a
    // missing group switch matches the schema default and must not silence a
    // user who had already turned the discovery alerts on.
    const legacyRow = {
      enabled: true,
      provider: "ntfy",
      notifyOnSyncError: true,
      notifyOnSyncSuccess: false,
      notifyOnNewRepo: true,
    } as NotificationConfig;

    expect(isNewRepositoryGroupEnabled(legacyRow, "own")).toBe(true);
    expect(isNewRepositoryGroupEnabled(legacyRow, "organization")).toBe(true);
    expect(isNewRepositoryGroupEnabled(legacyRow, "starred")).toBe(true);
  });
});

describe("buildAllReleasesRemovedNotificationEvent", () => {
  test("names the repository and the destination that lost its releases", () => {
    const event = buildAllReleasesRemovedNotificationEvent({
      repositoryName: "demo",
      destination: "mirrors/demo",
      removedCount: 3,
    });

    expect(event.title).toBe("All Releases Removed: demo");
    expect(event.type).toBe("sync_error");
    expect(event.message).toContain("3 releases deleted from mirrors/demo");
    expect(event.message).toContain("include/exclude tag patterns");
  });

  test("uses the singular when a single release was removed", () => {
    const event = buildAllReleasesRemovedNotificationEvent({
      repositoryName: "demo",
      destination: "mirrors/demo",
      removedCount: 1,
    });

    expect(event.message).toContain("1 release deleted");
  });
});

describe("triggerAllReleasesRemovedNotification", () => {
  test("stays silent when nothing was removed", async () => {
    await triggerAllReleasesRemovedNotification({
      userId: "user-1",
      repositoryName: "demo",
      destination: "mirrors/demo",
      removedCount: 0,
    });

    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  test("never throws when the user has no notification config", async () => {
    // The setup db mock resolves to no rows, so the config lookup finds none
    // and no provider is contacted.
    await triggerAllReleasesRemovedNotification({
      userId: "user-1",
      repositoryName: "demo",
      destination: "mirrors/demo",
      removedCount: 2,
    });

    expect(mockFetch).toHaveBeenCalledTimes(0);
  });
});
