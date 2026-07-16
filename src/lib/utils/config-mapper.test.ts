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

test("skipPersonalRepos defaults to false in githubConfigSchema", () => {
  const parsed = githubConfigSchema.parse({
    owner: "octo",
    type: "personal",
    token: "",
  });
  expect(parsed.skipPersonalRepos).toBe(false);
});

test("skipPersonalRepos round-trips UI -> DB -> UI when true", () => {
  const ui = buildMinimalUiConfigs();
  const advancedWithSkip: AdvancedOptions = { ...ui.advancedOptions, skipPersonalRepos: true };
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, advancedWithSkip);
  expect(db.githubConfig.skipPersonalRepos).toBe(true);

  const roundTripped = mapDbToUiConfig({ githubConfig: db.githubConfig, giteaConfig: db.giteaConfig });
  expect(roundTripped.advancedOptions.skipPersonalRepos).toBe(true);
});

test("skipPersonalRepos round-trips UI -> DB -> UI when false", () => {
  const ui = buildMinimalUiConfigs();
  const advancedWithSkip: AdvancedOptions = { ...ui.advancedOptions, skipPersonalRepos: false };
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, advancedWithSkip);
  expect(db.githubConfig.skipPersonalRepos).toBe(false);

  const roundTripped = mapDbToUiConfig({ githubConfig: db.githubConfig, giteaConfig: db.giteaConfig });
  expect(roundTripped.advancedOptions.skipPersonalRepos).toBe(false);
});

test("DB row missing skipPersonalRepos defaults to false on read", () => {
  const ui = mapDbToUiConfig({ githubConfig: { owner: "octo", token: "" } });
  expect(ui.advancedOptions.skipPersonalRepos).toBe(false);
});

// Regression for #326: the Name Collision Strategy dropdown didn't persist
// because starredDuplicateStrategy was missing from both mapper directions.
test("starredDuplicateStrategy round-trips UI -> DB -> UI when set to prefix", () => {
  const ui = buildMinimalUiConfigs();
  ui.githubConfig.starredDuplicateStrategy = "prefix";
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, ui.advancedOptions);
  expect(db.githubConfig.starredDuplicateStrategy).toBe("prefix");

  const roundTripped = mapDbToUiConfig({ githubConfig: db.githubConfig, giteaConfig: db.giteaConfig });
  expect(roundTripped.githubConfig.starredDuplicateStrategy).toBe("prefix");
});

test("starredDuplicateStrategy round-trips UI -> DB -> UI when set to suffix", () => {
  const ui = buildMinimalUiConfigs();
  ui.githubConfig.starredDuplicateStrategy = "suffix";
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, ui.advancedOptions);
  expect(db.githubConfig.starredDuplicateStrategy).toBe("suffix");

  const roundTripped = mapDbToUiConfig({ githubConfig: db.githubConfig, giteaConfig: db.giteaConfig });
  expect(roundTripped.githubConfig.starredDuplicateStrategy).toBe("suffix");
});

test("starredDuplicateStrategy defaults to suffix on save when unset", () => {
  const ui = buildMinimalUiConfigs();
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, ui.advancedOptions);
  expect(db.githubConfig.starredDuplicateStrategy).toBe("suffix");
});

test("DB row missing starredDuplicateStrategy defaults to suffix on read", () => {
  const ui = mapDbToUiConfig({ githubConfig: { owner: "octo", token: "" } });
  expect(ui.githubConfig.starredDuplicateStrategy).toBe("suffix");
});

// Regression for #338: saving any setting from the Configuration page reset
// giteaConfig.mirrorInterval (set via GITEA_MIRROR_INTERVAL) back to "8h"
// because the mapper hardcoded the default instead of preserving the stored value.
test("mapUiToDbConfig preserves env-configured mirrorInterval on save", () => {
  const ui = buildMinimalUiConfigs();
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, ui.advancedOptions, {
    giteaConfig: { mirrorInterval: "10m" },
  });
  expect(db.giteaConfig.mirrorInterval).toBe("10m");
});

test("mapUiToDbConfig defaults mirrorInterval to 8h without existing config", () => {
  const ui = buildMinimalUiConfigs();
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, ui.advancedOptions);
  expect(db.giteaConfig.mirrorInterval).toBe("8h");
});

test("mapUiToDbConfig preserves non-UI fields from existing config on save", () => {
  const ui = buildMinimalUiConfigs();
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, ui.advancedOptions, {
    githubConfig: { type: "organization", includeArchived: true, includePublic: false },
    giteaConfig: {
      createOrg: false,
      templateOwner: "templates",
      templateRepo: "base",
      addTopics: false,
      topicPrefix: "gh-",
      preserveVisibility: true,
    },
  });
  expect(db.githubConfig.type).toBe("organization");
  expect(db.githubConfig.includeArchived).toBe(true);
  expect(db.githubConfig.includePublic).toBe(false);
  expect(db.giteaConfig.createOrg).toBe(false);
  expect(db.giteaConfig.templateOwner).toBe("templates");
  expect(db.giteaConfig.templateRepo).toBe("base");
  expect(db.giteaConfig.addTopics).toBe(false);
  expect(db.giteaConfig.topicPrefix).toBe("gh-");
  expect(db.giteaConfig.preserveVisibility).toBe(true);
});

test("mapUiToDbConfig keeps env-configured full-copy forkStrategy when forks are included", () => {
  const ui = buildMinimalUiConfigs();
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, ui.advancedOptions, {
    giteaConfig: { forkStrategy: "full-copy" },
  });
  expect(db.giteaConfig.forkStrategy).toBe("full-copy");
});

test("mapUiToDbConfig lets skipForks override a stored forkStrategy", () => {
  const ui = buildMinimalUiConfigs();
  const withSkip: AdvancedOptions = { ...ui.advancedOptions, skipForks: true };
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, withSkip, {
    giteaConfig: { forkStrategy: "full-copy" },
  });
  expect(db.giteaConfig.forkStrategy).toBe("skip");
});

test("mapUiToDbConfig resets a stale skip forkStrategy to reference when skipForks is unchecked", () => {
  const ui = buildMinimalUiConfigs();
  const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, ui.advancedOptions, {
    giteaConfig: { forkStrategy: "skip" },
  });
  expect(db.giteaConfig.forkStrategy).toBe("reference");
});
