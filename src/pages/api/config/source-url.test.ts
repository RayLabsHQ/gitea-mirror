import { describe, expect, test } from "bun:test";
import { POST } from "./index";

function request(githubConfig: Record<string, unknown>) {
  return new Request("http://localhost/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: "user-1",
      githubConfig,
      giteaConfig: { url: "https://gitea.example.com", username: "me", token: "t" },
      scheduleConfig: { enabled: false },
      cleanupConfig: { enabled: false },
      mirrorOptions: { mirrorReleases: false },
      advancedOptions: { skipForks: false },
    }),
  });
}

async function post(githubConfig: Record<string, unknown>) {
  return POST({
    request: request(githubConfig),
    locals: { session: { userId: "user-1" } },
  } as any);
}

describe("POST /api/config source validation", () => {
  test("rejects an instance URL that is not http(s) for a GitLab source", async () => {
    const response = await post({
      username: "me",
      token: "glpat-x",
      provider: "gitlab",
      url: "ftp://gitlab.example.com",
    });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toContain("GitLab URL");
  });

  test("rejects an unknown source provider", async () => {
    const response = await post({ username: "me", token: "t", provider: "bitbucket" });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.message).toContain("Unknown source provider");
  });
});
