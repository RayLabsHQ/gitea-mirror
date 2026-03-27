import { describe, expect, test } from "bun:test";
import { buildGithubSourceAuthPayload } from "./mirror-source-auth";

describe("buildGithubSourceAuthPayload", () => {
  test("uses configured owner when available", () => {
    const auth = buildGithubSourceAuthPayload({
      token: "ghp_test_token",
      githubOwner: "ConfiguredOwner",
      githubUsername: "fallback-user",
      repositoryOwner: "repo-owner",
    });

    expect(auth).toEqual({
      auth_username: "ConfiguredOwner",
      auth_password: "ghp_test_token",
      auth_token: "ghp_test_token",
    });
  });

  test("falls back to configured username then repository owner", () => {
    const authFromUsername = buildGithubSourceAuthPayload({
      token: "token1",
      githubUsername: "configured-user",
      repositoryOwner: "repo-owner",
    });

    expect(authFromUsername.auth_username).toBe("configured-user");

    const authFromRepoOwner = buildGithubSourceAuthPayload({
      token: "token2",
      repositoryOwner: "repo-owner",
    });

    expect(authFromRepoOwner.auth_username).toBe("repo-owner");
  });

  test("uses x-access-token as last-resort username", () => {
    const auth = buildGithubSourceAuthPayload({
      token: "ghp_test_token",
    });

    expect(auth.auth_username).toBe("x-access-token");
  });

  test("trims token whitespace", () => {
    const auth = buildGithubSourceAuthPayload({
      token: "  ghp_trimmed  ",
      githubUsername: "user",
    });

    expect(auth.auth_password).toBe("ghp_trimmed");
    expect(auth.auth_token).toBe("ghp_trimmed");
  });

  test("throws when token is missing", () => {
    expect(() =>
      buildGithubSourceAuthPayload({
        token: "   ",
        githubUsername: "user",
      })
    ).toThrow("GitHub token is required to mirror private repositories.");
  });
});
