/**
 * Source regression tests for the source provider wiring (issue #375).
 *
 * The mirror pipeline, the scheduler, the cleanup service and the discovery
 * routes must go through the SourceProvider built from the configuration
 * instead of calling GitHub directly, and the two migrate sites must pick
 * clone credentials per provider and refuse a repository from another host.
 * These files need process-wide module mocks to exercise behaviorally, so
 * the wiring is asserted by reading the source (same convention as
 * stuck-status-recovery.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...segments: string[]) =>
  readFileSync(join(import.meta.dir, ...segments), "utf8");

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("gitea.ts migrate sites", () => {
  const source = read("gitea.ts");

  test("both migrate payloads take per-provider clone credentials", () => {
    expect(count(source, "buildSourceAuthPayload({")).toBe(2);
    expect(source).not.toContain("buildGithubSourceAuthPayload");
    expect(count(source, "provider: sourceConnection.provider,")).toBe(2);
  });

  test("both mirror paths refuse a repository from a different source before any side effect", () => {
    expect(count(source, "assertRepositoryMatchesConfiguredSource({ repository, config });")).toBe(2);
    const userPath = source.indexOf("export const mirrorGithubRepoToGitea");
    const guard = source.indexOf("assertRepositoryMatchesConfiguredSource({ repository, config });", userPath);
    const mirroringWrite = source.indexOf('repoStatusEnum.parse("mirroring")', userPath);
    expect(guard).toBeGreaterThan(userPath);
    expect(guard).toBeLessThan(mirroringWrite);
  });

  test("the mirror entry points accept a null GitHub client and skip metadata without one", () => {
    expect(count(source, "octokit: Octokit | null;")).toBeGreaterThanOrEqual(4);
    expect(count(source, "&& octokit !== null;")).toBe(10);
  });
});

describe("discovery and housekeeping go through the source provider", () => {
  test("scheduler auto import, auto mirror and boot auto start", () => {
    const source = read("scheduler-service.ts");
    expect(count(source, "createSourceProviderFromConfig(config")).toBe(2);
    expect(count(source, "sourceProvider.listRepositories(config)")).toBe(2);
    expect(source).not.toContain("getGithubRepositories(");
    // A GitHub client is built only for GitHub sources, in both mirror phases.
    expect(count(source, "resolveSourceProviderKind(config) === 'github'")).toBe(2);
  });

  test("cleanup lists, filters and verifies through the provider", () => {
    const source = read("repository-cleanup-service.ts");
    expect(source).toContain("createSourceProviderFromConfig(config, { userId })");
    expect(source).toContain("isRepositoryFromConfiguredSource(repo, sourceConnection)");
    expect(source).toContain("sourceProvider.getRepository(");
    expect(source).toContain("sourceProvider.isRepositoryStarred(");
    expect(source).not.toContain("octokit.rest");
    // The repository existence check goes by full name, not owner/name.
    expect(source).toContain("splitFullName(repo.fullName, repo.owner, repo.name)");
  });

  test("recovery and the sync path only build a GitHub client for GitHub sources", () => {
    expect(read("recovery.ts")).toContain("resolveSourceProviderKind(config) === 'github'");
    const enhanced = read("gitea-enhanced.ts");
    expect(count(enhanced, 'normalizeSourceProviderKind(config.githubConfig?.provider)')).toBe(2);
  });

  test("the metadata resolver clamps GitHub only options for other sources", () => {
    const source = read("utils", "mirror-overrides.ts");
    expect(source).toContain("GITHUB_ONLY_METADATA_KEYS");
    expect(source).toContain('normalizeSourceProviderKind(repository.sourceProvider) !== "github"');
  });

  test("the discovery routes use the provider and stamp the source on inserted rows", () => {
    for (const route of ["index.ts", "organization.ts", "repository.ts"]) {
      const source = read("..", "pages", "api", "sync", route);
      expect(source).toContain("createSourceProviderFromConfig(config, { userId })");
      expect(source).not.toContain("createGitHubClient(");
    }
    expect(read("repo-utils.ts")).toContain("repositorySourceColumns(repo)");
  });
});
