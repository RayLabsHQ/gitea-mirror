import { expect, test } from "bun:test";
import {
  mapDbScheduleToUi,
  mapDbToUiConfig,
  mapUiScheduleToDb,
  mapUiToDbConfig,
} from "./config-mapper";
import { githubConfigSchema, scheduleConfigSchema } from "@/lib/db/schema";
import type {
  AdvancedOptions,
  GitHubConfig,
  GiteaConfig,
  MirrorOptions,
} from "@/types/config";

function buildMinimalUiConfigs(overrides: { includeCollaboratorRepos?: boolean } = {}) {
  const githubConfig: GitHubConfig = {
    username: "octo",
    token: "ghp_x",
    privateRepositories: false,
    mirrorStarred: false,
    ...overrides,
  };
  const giteaConfig: GiteaConfig = {
    url: "https://gitea.example",
    username: "octo",
    token: "g_x",
    organization: "github-mirrors",
    visibility: "public",
    starredReposOrg: "starred",
    preserveOrgStructure: false,
  };
  const mirrorOptions: MirrorOptions = {
    mirrorReleases: false,
    mirrorLFS: false,
    mirrorMetadata: false,
    metadataComponents: {
      issues: false,
      pullRequests: false,
      labels: false,
      milestones: false,
      wiki: false,
    },
  };
  const advancedOptions: AdvancedOptions = {
    skipForks: false,
    starredCodeOnly: false,
  };
  return { githubConfig, giteaConfig, mirrorOptions, advancedOptions };
}

test("mapUiScheduleToDb - builds cron from start time + frequency", () => {
  const existing = scheduleConfigSchema.parse({});
  const mapped = mapUiScheduleToDb(
    {
      enabled: true,
      scheduleMode: "clock",
      clockFrequencyHours: 24,
      startTime: "22:00",
      timezone: "Asia/Kolkata",
    },
    existing
  );

  expect(mapped.enabled).toBe(true);
  expect(mapped.interval).toBe("0 22 * * *");
  expect(mapped.timezone).toBe("Asia/Kolkata");
});

test("mapDbScheduleToUi - infers clock mode for generated cron", () => {
  const mapped = mapDbScheduleToUi(
    scheduleConfigSchema.parse({
      enabled: true,
      interval: "15 22,6,14 * * *",
      timezone: "Asia/Kolkata",
    })
  );

  expect(mapped.scheduleMode).toBe("clock");
  expect(mapped.clockFrequencyHours).toBe(8);
  expect(mapped.startTime).toBe("22:15");
  expect(mapped.timezone).toBe("Asia/Kolkata");
});

test("includeCollaboratorRepos round-trips through UI -> DB -> UI when true", () => {
  const ui = buildMinimalUiConfigs({ includeCollaboratorRepos: true });
  const db = mapUiToDbConfig(
    ui.githubConfig,
    ui.giteaConfig,
    ui.mirrorOptions,
    ui.advancedOptions,
  );
  expect(db.githubConfig.includeCollaboratorRepos).toBe(true);

  const roundTripped = mapDbToUiConfig({ githubConfig: db.githubConfig, giteaConfig: db.giteaConfig });
  expect(roundTripped.githubConfig.includeCollaboratorRepos).toBe(true);
});

test("includeCollaboratorRepos round-trips through UI -> DB -> UI when false", () => {
  const ui = buildMinimalUiConfigs({ includeCollaboratorRepos: false });
  const db = mapUiToDbConfig(
    ui.githubConfig,
    ui.giteaConfig,
    ui.mirrorOptions,
    ui.advancedOptions,
  );
  expect(db.githubConfig.includeCollaboratorRepos).toBe(false);

  const roundTripped = mapDbToUiConfig({ githubConfig: db.githubConfig, giteaConfig: db.giteaConfig });
  expect(roundTripped.githubConfig.includeCollaboratorRepos).toBe(false);
});

test("DB row missing includeCollaboratorRepos defaults to true on read", () => {
  // Existing rows from before this field existed have no value stored.
  const ui = mapDbToUiConfig({ githubConfig: { owner: "octo", token: "" } });
  expect(ui.githubConfig.includeCollaboratorRepos).toBe(true);
});

test("githubConfigSchema parses includeCollaboratorRepos with true default", () => {
  const parsed = githubConfigSchema.parse({
    owner: "octo",
    type: "personal",
    token: "",
  });
  expect(parsed.includeCollaboratorRepos).toBe(true);
});
