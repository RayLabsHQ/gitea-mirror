import { expect, test } from "bun:test";
import {
  mapDbScheduleToUi,
  mapDbToUiConfig,
  mapUiScheduleToDb,
  mapUiToDbConfig,
  mapUiCleanupToDb,
  mapDbCleanupToUi,
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
    issueState: "all",
    issueComments: true,
    issueMedia: true,
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

test("mapDbScheduleToUi - reports interval mode for a plain interval instead of a clock schedule", () => {
  // What SCHEDULE_INTERVAL / GITEA_MIRROR_INTERVAL and older versions store.
  // The settings card must not present the 22:00 placeholder as saved (#427).
  const mapped = mapDbScheduleToUi(
    scheduleConfigSchema.parse({
      enabled: true,
      interval: "8h",
      timezone: "UTC",
    })
  );

  expect(mapped.scheduleMode).toBe("interval");
  expect(mapped.interval).toBe(8 * 3600);
  expect(mapped.intervalExpression).toBe("8h");
  expect(mapped.timezone).toBe("UTC");
});

test("autoImport round-trips UI -> DB -> UI (#541)", () => {
  const existing = scheduleConfigSchema.parse({});
  expect(existing.autoImport).toBe(true);

  const off = mapUiScheduleToDb({ enabled: true, autoImport: false }, existing);
  expect(off.autoImport).toBe(false);
  expect(mapDbScheduleToUi(off).autoImport).toBe(false);

  const on = mapUiScheduleToDb({ enabled: true, autoImport: true }, off);
  expect(on.autoImport).toBe(true);
  expect(mapDbScheduleToUi(on).autoImport).toBe(true);
});

test("a schedule save without autoImport keeps the stored value", () => {
  // AUTO_IMPORT_REPOS=false stored by the env loader must survive saving the
  // schedule from a client that does not send the switch.
  const stored = scheduleConfigSchema.parse({ autoImport: false });
  expect(mapUiScheduleToDb({ enabled: true }, stored).autoImport).toBe(false);
});

test("a stored schedule without autoImport reads as on, like the scheduler", () => {
  const legacy = { ...scheduleConfigSchema.parse({}) } as Record<string, unknown>;
  delete legacy.autoImport;
  expect(mapDbScheduleToUi(legacy as any).autoImport).toBe(true);
  expect(mapDbScheduleToUi(undefined as any).autoImport).toBe(true);
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

import { describe } from "bun:test";
import {
  mapDbToUiConfig as mapDbToUiConfigForSource,
  mapUiToDbConfig as mapUiToDbConfigForSource,
} from "./config-mapper";

describe("source provider round trip", () => {
  const giteaConfig = {
    url: "https://gitea.example.com",
    username: "me",
    token: "t",
    organization: "mirrors",
    visibility: "public",
    starredReposOrg: "starred",
    preserveOrgStructure: false,
  } as any;
  const mirrorOptions = {
    mirrorReleases: false,
    mirrorLFS: false,
    mirrorMetadata: false,
    metadataComponents: { issues: false, pullRequests: false, labels: false, milestones: false, wiki: false },
  } as any;
  const advancedOptions = { skipForks: false, starredCodeOnly: false } as any;

  test("stores a normalized instance URL for GitLab and Gitea sources", () => {
    const { githubConfig } = mapUiToDbConfigForSource(
      { provider: "gitlab", url: "GitLab.example.com/", username: "me", token: "t", privateRepositories: false, mirrorStarred: false },
      giteaConfig,
      mirrorOptions,
      advancedOptions
    );
    expect(githubConfig.provider).toBe("gitlab");
    expect(githubConfig.url).toBe("https://gitlab.example.com");
  });

  test("GitHub stores no URL and an empty URL means the provider default", () => {
    const github = mapUiToDbConfigForSource(
      { provider: "github", url: "https://github.com", username: "me", token: "t", privateRepositories: false, mirrorStarred: false },
      giteaConfig,
      mirrorOptions,
      advancedOptions
    ).githubConfig;
    expect(github.provider).toBe("github");
    expect(github.url).toBeUndefined();

    const gitea = mapUiToDbConfigForSource(
      { provider: "gitea", url: "  ", username: "me", token: "t", privateRepositories: false, mirrorStarred: false },
      giteaConfig,
      mirrorOptions,
      advancedOptions
    ).githubConfig;
    expect(gitea.provider).toBe("gitea");
    expect(gitea.url).toBeUndefined();
  });

  test("a saved provider survives a UI payload that does not mention it", () => {
    const { githubConfig } = mapUiToDbConfigForSource(
      { username: "me", token: "t", privateRepositories: false, mirrorStarred: false },
      giteaConfig,
      mirrorOptions,
      advancedOptions,
      { githubConfig: { provider: "gitea", url: "https://codeberg.org" } as any }
    );
    expect(githubConfig.provider).toBe("gitea");
    expect(githubConfig.url).toBe("https://codeberg.org");
  });

  test("a legacy row maps to GitHub with an empty URL in the UI", () => {
    const { githubConfig } = mapDbToUiConfigForSource({ githubConfig: { owner: "octo", token: "" } });
    expect(githubConfig.provider).toBe("github");
    expect(githubConfig.url).toBe("");
  });
});

describe("mapUiCleanupToDb run times (#548)", () => {
  const DAY = 86400;
  const now = new Date("2026-11-24T12:00:00Z");
  const lastRun = new Date("2026-11-24T06:00:00Z");
  const weekAway = new Date("2026-12-01T12:00:00Z");
  const stored = {
    enabled: true,
    retentionDays: 90 * DAY,
    deleteIfNotInGitHub: true,
    orphanedRepoAction: "archive" as const,
    dryRun: false,
    lastRun,
    nextRun: weekAway,
  };

  test("a shorter retention period moves the next run forward", () => {
    const saved = mapUiCleanupToDb({ ...stored, retentionDays: 1 * DAY }, stored as any, now);
    expect(saved.nextRun).toEqual(new Date("2026-11-24T18:00:00Z"));
    expect(saved.lastRun).toEqual(lastRun);
  });

  test("times sent by the page are ignored when a row is stored", () => {
    const saved = mapUiCleanupToDb(
      { ...stored, lastRun: new Date("2020-01-01T00:00:00Z"), nextRun: new Date("2020-01-02T00:00:00Z") },
      stored as any,
      now
    );
    expect(saved.lastRun).toEqual(lastRun);
    expect(saved.nextRun).toEqual(weekAway);
  });

  test("a first save schedules the next run", () => {
    const saved = mapUiCleanupToDb({ enabled: true, retentionDays: 7 * DAY }, undefined, now);
    expect(saved.nextRun).toEqual(new Date("2026-11-25T12:00:00Z"));
  });
});

describe("Apply to the destination too (#558)", () => {
  const base = {
    enabled: true,
    retentionDays: 7 * 86400,
    deleteIfNotInGitHub: true,
    orphanedRepoAction: "archive" as const,
    dryRun: false,
  };

  test("the switch round-trips UI -> DB -> UI when on", () => {
    const saved = mapUiCleanupToDb({ ...base, deleteFromGitea: true });
    expect(saved.deleteFromGitea).toBe(true);
    expect(mapDbCleanupToUi(saved).deleteFromGitea).toBe(true);
  });

  test("turning it off is saved", () => {
    const stored = mapUiCleanupToDb({ ...base, deleteFromGitea: true });
    const saved = mapUiCleanupToDb({ ...base, deleteFromGitea: false }, stored);
    expect(saved.deleteFromGitea).toBe(false);
    expect(mapDbCleanupToUi(saved).deleteFromGitea).toBe(false);
  });

  test("a stored row without the field reads as off, like the cleanup service", () => {
    const { deleteFromGitea: _omit, ...row } = mapUiCleanupToDb(base);
    expect(mapDbCleanupToUi(row as any).deleteFromGitea).toBe(false);
  });
});

describe("pre-release limit (#560)", () => {
  const roundTrip = (prereleaseLimit: number | null | undefined) => {
    const ui = buildMinimalUiConfigs();
    const db = mapUiToDbConfig(
      ui.githubConfig,
      ui.giteaConfig,
      { ...ui.mirrorOptions, mirrorReleases: true, prereleaseLimit },
      ui.advancedOptions,
    );
    return {
      stored: db.giteaConfig.prereleaseLimit,
      read: mapDbToUiConfig({ githubConfig: db.githubConfig, giteaConfig: db.giteaConfig })
        .mirrorOptions.prereleaseLimit,
    };
  };

  test("0 and N round-trip UI -> DB -> UI", () => {
    expect(roundTrip(0)).toEqual({ stored: 0, read: 0 });
    expect(roundTrip(3)).toEqual({ stored: 3, read: 3 });
  });

  test("empty or junk stores null, no separate limit", () => {
    expect(roundTrip(null)).toEqual({ stored: null, read: null });
    expect(roundTrip(undefined)).toEqual({ stored: null, read: null });
    expect(roundTrip(-4)).toEqual({ stored: null, read: null });
  });

  test("a stored row without the field reads as no limit", () => {
    const ui = buildMinimalUiConfigs();
    const db = mapUiToDbConfig(ui.githubConfig, ui.giteaConfig, ui.mirrorOptions, ui.advancedOptions);
    const { prereleaseLimit: _dropped, ...legacy } = db.giteaConfig as Record<string, unknown>;
    expect(
      mapDbToUiConfig({ githubConfig: db.githubConfig, giteaConfig: legacy as any }).mirrorOptions
        .prereleaseLimit
    ).toBeNull();
  });
});

describe("starred destination mode (#551)", () => {
  const roundTrip = (starredReposMode: unknown) => {
    const ui = buildMinimalUiConfigs();
    const db = mapUiToDbConfig(
      ui.githubConfig,
      { ...ui.giteaConfig, starredReposMode: starredReposMode as any },
      ui.mirrorOptions,
      ui.advancedOptions,
    );
    return {
      stored: db.githubConfig.starredReposMode,
      read: mapDbToUiConfig({ githubConfig: db.githubConfig, giteaConfig: db.giteaConfig }).giteaConfig
        .starredReposMode,
    };
  };

  test("follow-strategy round-trips UI -> DB -> UI", () => {
    expect(roundTrip("follow-strategy")).toEqual({ stored: "follow-strategy", read: "follow-strategy" });
    expect(roundTrip("preserve-owner")).toEqual({ stored: "preserve-owner", read: "preserve-owner" });
  });

  test("a missing or unknown mode is stored as dedicated-org", () => {
    expect(roundTrip(undefined)).toEqual({ stored: "dedicated-org", read: "dedicated-org" });
    expect(roundTrip("sideways")).toEqual({ stored: "dedicated-org", read: "dedicated-org" });
  });
});
