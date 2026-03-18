import { describe, expect, test } from "bun:test";
import { POST } from "./index";

describe("POST /api/config notification validation", () => {
  test("returns 400 for invalid notificationConfig payload", async () => {
    const request = new Request("http://localhost/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubConfig: { username: "octo", token: "ghp_x" },
        giteaConfig: { url: "https://gitea.example.com", token: "gt_x", username: "octo" },
        scheduleConfig: { enabled: true, interval: 3600 },
        cleanupConfig: { enabled: false, retentionDays: 604800 },
        mirrorOptions: {
          mirrorReleases: false,
          releaseLimit: 10,
          mirrorLFS: false,
          mirrorMetadata: false,
          metadataComponents: {
            issues: false,
            pullRequests: false,
            labels: false,
            milestones: false,
            wiki: false,
          },
        },
        advancedOptions: {
          skipForks: false,
          starredCodeOnly: false,
          autoMirrorStarred: false,
        },
        notificationConfig: {
          enabled: true,
          provider: "invalid-provider",
        },
      }),
    });

    const response = await POST({
      request,
      locals: {
        session: { userId: "user-1" },
      },
    } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toContain("Invalid notificationConfig");
  });
});
