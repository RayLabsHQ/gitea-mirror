/**
 * Source regression tests for the source provider wiring (issue #375).
 *
 * The mirror pipeline, the scheduler, the cleanup service and the discovery
 * routes must go through the SourceProvider built from the user's connected
 * source rows instead of calling GitHub directly, and the two migrate sites
 * must pick clone credentials from the repository's own source and refuse a
 * repository from a host that is not connected. These files need
 * process-wide module mocks to exercise behaviorally, so the wiring is
 * asserted by reading the source (same convention as
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

  test("both mirror paths refuse a repository from an unconnected source before any side effect", () => {
    expect(count(source, "assertRepositoryMatchesConnectedSource({ repository, sources });")).toBe(2);
    const userPath = source.indexOf("export const mirrorGithubRepoToGitea");
    const guard = source.indexOf("assertRepositoryMatchesConnectedSource({ repository, sources });", userPath);
    const mirroringWrite = source.indexOf('repoStatusEnum.parse("mirroring")', userPath);
    expect(guard).toBeGreaterThan(userPath);
    expect(guard).toBeLessThan(mirroringWrite);
  });

  test("both mirror paths resolve the repository's own source for clone credentials", () => {
    expect(count(source, "findSourceForRepository(repository, sources)")).toBe(2);
    expect(count(source, "sourceConnectionFromSource(repoSource, { userId: config.userId })")).toBe(2);
  });

  test("the mirror entry points accept a null GitHub client and skip metadata without one", () => {
    expect(count(source, "octokit: Octokit | null;")).toBeGreaterThanOrEqual(4);
    expect(count(source, "&& octokit !== null;")).toBe(10);
  });
});

describe("discovery and housekeeping go through the source provider", () => {
  test("scheduler auto import, auto mirror and boot auto start iterate the connected sources", () => {
    const source = read("scheduler-service.ts");
    expect(source).toContain("createSourceProviderFromSource(source, { userId })");
    // Auto import passes the per-organization fork pins through every source.
    expect(source).toContain("sourceProvider.listRepositories(config, { orgForkOverrides })");
    expect(source).not.toContain("getGithubRepositories(");
    // Auto import, auto mirror and boot auto start each load the user's sources.
    expect(count(source, "listSources(")).toBeGreaterThanOrEqual(3);
    // A GitHub client is built per source (only for GitHub sources), cached per batch.
    expect(source).toContain("source.provider === 'github'");
  });

  test("cleanup lists, filters and verifies through the provider", () => {
    const source = read("repository-cleanup-service.ts");
    expect(source).toContain("createSourceProviderFromSource(source, { userId })");
    expect(source).toContain("isRepositoryFromConfiguredSource(repo, sourceConnection)");
    expect(source).toContain("sourceProvider.getRepository(");
    expect(source).toContain("sourceProvider.isRepositoryStarred(");
    expect(source).not.toContain("octokit.rest");
    // The repository existence check goes by full name, not owner/name.
    expect(source).toContain("splitFullName(repo.fullName, repo.owner, repo.name)");
  });

  test("recovery and the sync path resolve the GitHub client from the repository's own source", () => {
    const recovery = read("recovery.ts");
    expect(recovery).toContain("findSourceForRepository(repo, sources)");
    expect(recovery).toContain("repoSource?.provider === 'github'");
    const enhanced = read("gitea-enhanced.ts");
    expect(enhanced).toContain("getRepositorySource(repository).provider === \"github\"");
    expect(enhanced).toContain("findSourceForRepository(repository, sources)");
  });

  test("the metadata resolver clamps GitHub only options for other sources", () => {
    const source = read("utils", "mirror-overrides.ts");
    expect(source).toContain("GITHUB_ONLY_METADATA_KEYS");
    expect(source).toContain('normalizeSourceProviderKind(repository.sourceProvider) !== "github"');
  });

  test("the discovery routes use the provider, match the pasted host against connected sources and stamp the source on inserted rows", () => {
    for (const route of ["index.ts", "organization.ts", "repository.ts"]) {
      const source = read("..", "pages", "api", "sync", route);
      expect(source).toContain("createSourceProviderFromSource(source, { userId })");
      expect(source).not.toContain("createGitHubClient(");
    }
    expect(read("..", "pages", "api", "sync", "repository.ts")).toContain(
      "sourceHostOf(s.url) === pastedHost"
    );
    expect(read("..", "pages", "api", "sync", "index.ts")).toContain("sourceId: source.id");
    expect(read("repo-utils.ts")).toContain("repositorySourceColumns(repo)");
  });
});

describe("source and destination locks", () => {
  test("the config API reports locks and refuses unconfirmed changes to a locked host", () => {
    const source = read("..", "pages", "api", "config", "index.ts");
    expect(source).toContain("loadConfigLocks(userId)");
    expect(source).toContain("evaluateConfigChange({");
    expect(source).toContain("status: 409");
    // Every GET branch carries the locks so the page can disable the fields.
    expect(count(source, "locks,\n")).toBeGreaterThanOrEqual(3);
  });

  test("environment variables cannot switch a locked host on boot", () => {
    const source = read("env-config-loader.ts");
    expect(source).toContain("hasSourceChanged(stored.githubConfig, incomingSource)");
    expect(source).toContain("hasDestinationChanged(stored.giteaConfig?.url, envConfig.gitea.url)");
  });

  test("both connection cards disable the host fields while locked and confirm through the dialog", () => {
    const github = read("..", "components", "config", "GitHubConfigForm.tsx");
    expect(github).toContain("disabled={sourceLocked}");
    expect(github).toContain("confirmSourceChange: sourceUnlocked");
    const gitea = read("..", "components", "config", "GiteaConfigForm.tsx");
    expect(gitea).toContain("disabled={destinationLocked}");
    expect(gitea).toContain("confirmDestinationChange: destinationUnlocked");
  });
});
