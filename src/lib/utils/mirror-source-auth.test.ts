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

  test("returns empty object when token is missing", () => {
    const result = buildGithubSourceAuthPayload({
      token: "   ",
      githubUsername: "user",
    });

    expect(result).toEqual({});
  });
});

import { buildSourceAuthPayload } from "./mirror-source-auth";

describe("buildSourceAuthPayload", () => {
  test("GitHub keeps the account name plus token as password", () => {
    expect(
      buildSourceAuthPayload({
        provider: "github",
        token: "ghp_x",
        username: "octo",
        repositoryOwner: "someone",
      })
    ).toEqual({ auth_username: "octo", auth_password: "ghp_x", auth_token: "ghp_x" });
  });

  test("GitLab always uses the oauth2 username with a personal access token", () => {
    expect(
      buildSourceAuthPayload({
        provider: "gitlab",
        token: " glpat-x ",
        username: "me",
        repositoryOwner: "acme",
      })
    ).toEqual({ auth_username: "oauth2", auth_password: "glpat-x", auth_token: "glpat-x" });
  });

  test("Gitea uses the configured username, then the repository owner, then a placeholder", () => {
    expect(
      buildSourceAuthPayload({ provider: "gitea", token: "t", username: "me", repositoryOwner: "acme" })
        .auth_username
    ).toBe("me");
    expect(
      buildSourceAuthPayload({ provider: "gitea", token: "t", username: "", repositoryOwner: "acme" })
        .auth_username
    ).toBe("acme");
    expect(buildSourceAuthPayload({ provider: "gitea", token: "t" }).auth_username).toBe("token");
  });

  test("returns an empty object without a token for every provider", () => {
    for (const provider of ["github", "gitlab", "gitea"] as const) {
      expect(buildSourceAuthPayload({ provider, token: "  ", username: "me" })).toEqual({});
    }
  });
});
