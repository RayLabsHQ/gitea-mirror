import path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { defaultDbPath, resolveDbPath } from "./path";
import { resolveDataDir } from "@/lib/push-engine/paths";

describe("resolveDbPath", () => {
  let saved: string | undefined;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    warn.mockRestore();
  });

  test("uses data/gitea-mirror.db when DATABASE_URL is not set", () => {
    expect(resolveDbPath()).toBe(path.join(process.cwd(), "data", "gitea-mirror.db"));
    process.env.DATABASE_URL = "  ";
    expect(resolveDbPath()).toBe(defaultDbPath());
  });

  test("takes sqlite://, file: and plain paths", () => {
    process.env.DATABASE_URL = "sqlite://data/other.db";
    expect(resolveDbPath()).toBe(path.resolve("data/other.db"));
    process.env.DATABASE_URL = "file:data/gitea-mirror.db";
    expect(resolveDbPath()).toBe(path.resolve("data/gitea-mirror.db"));
    process.env.DATABASE_URL = "file:/srv/gitea-mirror/db.sqlite";
    expect(resolveDbPath()).toBe("/srv/gitea-mirror/db.sqlite");
    process.env.DATABASE_URL = "/srv/gitea-mirror/plain.db";
    expect(resolveDbPath()).toBe("/srv/gitea-mirror/plain.db");
    process.env.DATABASE_URL = "relative/plain.db";
    expect(resolveDbPath()).toBe(path.resolve("relative/plain.db"));
    expect(warn).not.toHaveBeenCalled();
  });

  test("ignores a Postgres URL and says so once, without the password (#502)", () => {
    process.env.DATABASE_URL = "postgresql://gm:secret@postgres:5432/gitea_mirror";
    expect(resolveDbPath()).toBe(defaultDbPath());
    expect(resolveDbPath()).toBe(defaultDbPath());

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("postgresql://");
    expect(message).toContain("only supports SQLite");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("postgres:5432");
  });

  test("ignores any other scheme too", () => {
    process.env.DATABASE_URL = "mysql://root@db/gitea_mirror";
    expect(resolveDbPath()).toBe(defaultDbPath());
    process.env.DATABASE_URL = "libsql://example.turso.io";
    expect(resolveDbPath()).toBe(defaultDbPath());
  });

  test("the push engine keeps its clones in the same data directory", () => {
    process.env.DATABASE_URL = "postgres://gm:secret@postgres/gitea_mirror";
    expect(resolveDataDir()).toBe(path.join(process.cwd(), "data"));
    process.env.DATABASE_URL = "file:/srv/gitea-mirror/db.sqlite";
    expect(resolveDataDir()).toBe("/srv/gitea-mirror");
  });
});
