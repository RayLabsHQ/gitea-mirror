import { describe, expect, test } from "bun:test";
import {
  insertMirrorPairSchema,
  insertServerSchema,
  mirrorPairSchema,
  serverSchema,
  updateMirrorPairSchema,
  updateServerSchema,
} from "./schema";

const validServer = {
  id: "srv-1",
  userId: "user-1",
  name: "GitHub",
  type: "github",
  username: "octo",
  token: "ghp_x",
  url: "https://github.com",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const validPair = {
  id: "pair-1",
  userId: "user-1",
  sourceServerId: "srv-1",
  targetServerId: "srv-2",
  username: "octo",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("serverSchema", () => {
  test("accepts a valid server payload", () => {
    const parsed = serverSchema.parse(validServer);
    expect(parsed.type).toBe("github");
    expect(parsed.externalUrl).toBeUndefined();
  });

  test("accepts every supported server type", () => {
    for (const type of ["github", "gitlab", "gitea", "forgejo", "git"]) {
      expect(serverSchema.parse({ ...validServer, type }).type).toBe(type);
    }
  });

  test("rejects an unknown server type", () => {
    expect(serverSchema.safeParse({ ...validServer, type: "bitbucket" }).success).toBe(false);
  });

  test("rejects an invalid url", () => {
    expect(serverSchema.safeParse({ ...validServer, url: "not-a-url" }).success).toBe(false);
  });

  test("rejects an invalid externalUrl / lfsEndpoint", () => {
    expect(serverSchema.safeParse({ ...validServer, externalUrl: "nope" }).success).toBe(false);
    expect(serverSchema.safeParse({ ...validServer, lfsEndpoint: "nope" }).success).toBe(false);
  });
});

describe("insertServerSchema / updateServerSchema", () => {
  test("insert schema omits id/userId/timestamps", () => {
    const parsed = insertServerSchema.parse({
      name: "Gitea",
      type: "gitea",
      username: "octo",
      token: "tok",
      url: "https://gitea.example.com",
    });
    expect(parsed.name).toBe("Gitea");
  });

  test("update schema allows partial payloads", () => {
    expect(updateServerSchema.parse({ name: "Renamed" }).name).toBe("Renamed");
    expect(updateServerSchema.parse({}).name).toBeUndefined();
  });
});

describe("mirrorPairSchema", () => {
  test("applies defaults for mirrorType, enabled and options", () => {
    const parsed = mirrorPairSchema.parse(validPair);
    expect(parsed.mirrorType).toBe("one-way");
    expect(parsed.enabled).toBe(true);
    expect(parsed.options.repositorySelection.mode).toBe("all");
    expect(parsed.options.organizationStructure.strategy).toBe("preserve");
    expect(parsed.options.organizationStructure.starredReposMode).toBe("dedicated-org");
    expect(parsed.options.organizationStructure.visibility).toBe("public");
    expect(parsed.options.destructiveProtection.backupStrategy).toBe("on-force-push");
    expect(parsed.options.mirrorContent.wiki).toBe(false);
  });

  test("accepts a two-way pair", () => {
    expect(mirrorPairSchema.parse({ ...validPair, mirrorType: "two-way" }).mirrorType).toBe("two-way");
  });

  test("accepts the full organization configuration", () => {
    const parsed = mirrorPairSchema.parse({
      ...validPair,
      options: {
        organizationStructure: {
          strategy: "mixed",
          singleOrg: "personal-mirrors",
          starredReposOrg: "starred-mirrors",
          starredReposMode: "preserve-owner",
          visibility: "limited",
        },
      },
    });

    expect(parsed.options.organizationStructure).toMatchObject({
      strategy: "mixed",
      singleOrg: "personal-mirrors",
      starredReposOrg: "starred-mirrors",
      starredReposMode: "preserve-owner",
      visibility: "limited",
    });
  });

  test("rejects an unknown mirror type", () => {
    expect(mirrorPairSchema.safeParse({ ...validPair, mirrorType: "three-way" }).success).toBe(false);
  });

  test("rejects invalid options payloads", () => {
    expect(
      mirrorPairSchema.safeParse({
        ...validPair,
        options: { repositorySelection: { mode: "everything" } },
      }).success,
    ).toBe(false);
    expect(
      mirrorPairSchema.safeParse({
        ...validPair,
        options: { destructiveProtection: { backupStrategy: "sometimes" } },
      }).success,
    ).toBe(false);
  });
});

describe("insertMirrorPairSchema / updateMirrorPairSchema", () => {
  test("insert schema requires source/target servers and username", () => {
    const parsed = insertMirrorPairSchema.parse({
      sourceServerId: "srv-1",
      targetServerId: "srv-2",
      username: "octo",
    });
    expect(parsed.enabled).toBe(true);
  });

  test("insert schema rejects missing target server", () => {
    expect(
      insertMirrorPairSchema.safeParse({ sourceServerId: "srv-1", username: "octo" }).success,
    ).toBe(false);
  });

  test("update schema supports toggling enabled only", () => {
    expect(updateMirrorPairSchema.parse({ enabled: false }).enabled).toBe(false);
  });
});
