/**
 * withoutUserInfo (#587): the settings export must drop every user:password
 * a URL can carry, cutting where a URL parser would, so no part of a
 * password survives.
 */
import { describe, test, expect } from "bun:test";
import { buildSettingsExport, withoutUserInfo } from "./settings-export";

describe("withoutUserInfo", () => {
  test.each([
    ["https://bob:secret@gitea.example.com", "https://gitea.example.com"],
    ["https://bob:secret@gitea.example.com:3000/sub?x=1#f", "https://gitea.example.com:3000/sub?x=1#f"],
    ["https://token@gitea.example.com", "https://gitea.example.com"],
    // A URL parser ends the user info at the last "@", not the first.
    ["https://bob:p@ss@gitea.example.com/x", "https://gitea.example.com/x"],
    ["https://bob:p@s@s@gitea.example.com", "https://gitea.example.com"],
    // A space in a password parses, so it must go too.
    ["https://bob:pa ss@gitea.example.com", "https://gitea.example.com"],
    ["ssh://git@host.example.com:22/repo.git", "ssh://host.example.com:22/repo.git"],
    // Rebuilt from the parse, so host and scheme come out normalized.
    ["HTTPS://Bob:Secret@Gitea.Example.com", "https://gitea.example.com"],
    // Forms a URL parser accepts that a string match would miss.
    ["  https://bob:secret@gitea.example.com", "https://gitea.example.com"],
    ["https:///bob:secret@gitea.example.com", "https://gitea.example.com"],
    ["https:\\\\bob:secret@gitea.example.com", "https://gitea.example.com"],
    ["https:bob:secret@gitea.example.com", "https://gitea.example.com"],
    ["https://bob:se\tcr\net@gitea.example.com", "https://gitea.example.com"],
    ["https://bob:secret@gitea.example.com/", "https://gitea.example.com/"],
  ])("%s", (input, expected) => {
    expect(withoutUserInfo(input)).toBe(expected);
  });

  test("leaves URLs without user info and plain text alone", () => {
    for (const value of [
      "https://gitea.example.com",
      "https://gitea.example.com/user@example.com/repo",
      "https://gitea.example.com/a?mail=a@b.c",
      "https://gitea.example.com/#a@b",
      "alex@example.com",
      "mailto:alex@example.com",
      "note: ask alex@example.com",
      "git@github.com:octo/repo.git",
      "0 22 * * *",
      "",
    ]) {
      expect(withoutUserInfo(value)).toBe(value);
    }
  });

  test("a URL that does not parse loses everything up to its last @", () => {
    // A raw "/", "?" or "#" in a password stops a URL parser, but the
    // string still holds the password.
    for (const password of ["pa/ss", "pa?ss", "pa#ss", "pa\\ss"]) {
      const out = withoutUserInfo(`https://bob:${password}@gitea.example.com/x`);
      expect(out).toBe("https://gitea.example.com/x");
    }
  });

  test("no user info survives any form the parser accepts", () => {
    const forms = (userinfo: string) => [
      `https://${userinfo}@h.example.com/p`,
      ` \thttps://${userinfo}@h.example.com`,
      `https:////${userinfo}@h.example.com`,
      `https:\\${userinfo}@h.example.com`,
      `https:/\\/${userinfo}@h.example.com`,
      `https:${userinfo}@h.example.com`,
      `HTTP://${userinfo}@h.example.com:8080`,
      `ws://${userinfo}@h.example.com`,
      `ssh://${userinfo}@h.example.com/r.git`,
    ];
    for (const userinfo of ["zed:hunter2", "zed:hun@ter2", "zed:hun ter2", "zed:hun\nter2", "zed", ":hunter2"]) {
      for (const input of forms(userinfo)) {
        let before: URL | null = null;
        try {
          before = new URL(input);
        } catch {
          // Covered by the fallback test.
        }
        if (!before) continue;
        const out = withoutUserInfo(input);
        const after = new URL(out);
        expect(after.username).toBe("");
        expect(after.password).toBe("");
        expect(out).not.toContain("zed");
        expect(out).not.toContain("hun");
        expect(after.host).toBe(before.host);
      }
    }
  });

  test("whatever parses has no user name or password afterwards", () => {
    const passwords = ["s", "p@ss", "pa ss", "p:ss", "p%40ss", "@", "a@b@c", "ü", "p;ss", "p=ss&x"];
    for (const scheme of ["https", "http", "ssh", "git"]) {
      for (const password of passwords) {
        const input = `${scheme}://bob:${password}@host.example.com/path`;
        const out = withoutUserInfo(input);
        let parsed: URL | null = null;
        try {
          parsed = new URL(out);
        } catch {
          // Checked below by the plain text test.
        }
        if (parsed) {
          expect(parsed.username).toBe("");
          expect(parsed.password).toBe("");
        }
        expect(out).not.toContain("bob");
        expect(out).toBe(`${scheme}://host.example.com/path`);
      }
    }
  });
});

describe("buildSettingsExport scrubbing", () => {
  test("cleans URLs nested anywhere in the settings and the source list", () => {
    const file = buildSettingsExport({
      config: {
        giteaConfig: { url: "https://admin:p@ss@gitea.example.com", externalUrl: "https://x:y z@public.example.com" },
        notificationConfig: { apprise: { url: "https://u:p@w@apprise.example.com/notify" } },
      },
      sources: [{ id: "s", name: "S", provider: "gitea", url: "https://bob:p@ss@codeberg.org", username: "bob" }],
      organizations: [],
      repositories: [],
    });
    const text = JSON.stringify(file);
    for (const fragment of ["admin", "p@ss", "ss@", "y z", "u:p", "w@"]) {
      expect(text).not.toContain(fragment);
    }
    expect((file.settings as any).giteaConfig.url).toBe("https://gitea.example.com");
    expect((file.sources as any)[0].url).toBe("https://codeberg.org");
    expect((file.sources as any)[0].reference).toBe("gitea https://codeberg.org bob");
  });
});
