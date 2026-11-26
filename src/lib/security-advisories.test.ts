/**
 * Security advisories mirrored as issues (#561).
 *
 * Other test files replace the HTTP client and the destination listing with
 * mock.module, so this file runs in its own process with the real modules and
 * a fake fetch standing in for the destination.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { runsIsolated } from "@/tests/isolated";

const isolated = runsIsolated(import.meta.path);

const mod = isolated
  ? await import("./security-advisories")
  : ({} as typeof import("./security-advisories"));

type Advisory = import("./security-advisories").SourceSecurityAdvisory;

function advisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    ghsa_id: "GHSA-g95c-wqvr-8c3j",
    cve_id: "CVE-2026-12345",
    html_url: "https://github.com/octo/app/security/advisories/GHSA-g95c-wqvr-8c3j",
    summary: "Admin roles can change another user's phone number",
    description: "An admin with `user:update` can change any phone number.",
    severity: "medium",
    state: "published",
    published_at: "2026-11-03T22:07:18Z",
    withdrawn_at: null,
    cwe_ids: ["CWE-863"],
    cvss: { score: 6.8, vector_string: "CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:N" },
    vulnerabilities: [
      {
        package: { ecosystem: "npm", name: "app" },
        vulnerable_version_range: "< 1.7.16",
        patched_versions: "1.7.16",
      },
    ],
    credits_detailed: [{ user: { login: "finder" }, type: "reporter" }],
    ...overrides,
  };
}

/** A fake Octokit whose advisory listing answers with `list`, or throws `error`. */
function fakeOctokit(list: Advisory[], error?: unknown) {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    octokit: {
      paginate: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        if (error) throw error;
        return list;
      },
    } as any,
  };
}

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: number[];
}

/** A fake destination: labels and issues of one repository. */
function fakeGitea({ labels = [] as Array<{ id: number; name: string }>, issues = [] as FakeIssue[], failIssueListing = false } = {}) {
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  let nextIssue = 100;
  let nextLabel = 50;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace("/api/v1/repos/mirrors/app", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: `${path}${url.search}`, body });
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

    if (method === "GET" && path === "/labels") {
      return json(url.searchParams.get("page") === "1" ? labels : [], 200, { "x-total-count": String(labels.length) });
    }
    if (method === "POST" && path === "/labels") {
      const label = { id: nextLabel++, name: body.name };
      labels.push(label);
      return json(label, 201);
    }
    if (method === "GET" && path === "/issues") {
      if (failIssueListing) return json({ message: "boom" }, 500);
      const labelName = url.searchParams.get("labels");
      const labelId = labels.find((label) => label.name === labelName)?.id;
      const matching = issues.filter((issue) => labelId !== undefined && issue.labels.includes(labelId));
      return json(url.searchParams.get("page") === "1" ? matching : [], 200, { "x-total-count": String(matching.length) });
    }
    if (method === "POST" && path === "/issues") {
      const issue: FakeIssue = { number: nextIssue++, title: body.title, body: body.body, state: "open", labels: body.labels };
      issues.push(issue);
      return json(issue, 201);
    }
    const patchMatch = path.match(/^\/issues\/(\d+)$/);
    if (method === "PATCH" && patchMatch) {
      const issue = issues.find((candidate) => candidate.number === Number(patchMatch[1]))!;
      Object.assign(issue, body);
      return json(issue);
    }
    return json({ message: `unexpected ${method} ${path}` }, 404);
  }) as typeof fetch;
  return { requests, issues, labels };
}

const config = { giteaConfig: { url: "https://gitea.example.com", token: "gitea-token" } } as any;
const repository = { name: "app", fullName: "octo/app" } as any;
const run = (octokit: any) =>
  mod.mirrorSecurityAdvisoriesToGitea({ config, octokit, repository, giteaOwner: "mirrors", giteaRepoName: "app" });

describe.skipIf(!isolated)("security advisories (#561)", () => {
  describe("advisoryIdFromTitle", () => {
    test("reads the GHSA id from the title marker", () => {
      expect(mod.advisoryIdFromTitle("[GHSA-g95c-wqvr-8c3j] Something")).toBe("GHSA-g95c-wqvr-8c3j");
      expect(mod.advisoryIdFromTitle("[ghsa-G95C-WQVR-8C3J] Something")).toBe("GHSA-g95c-wqvr-8c3j");
      expect(mod.advisoryIdFromTitle("[GH-ISSUE #4] Something")).toBeNull();
      expect(mod.advisoryIdFromTitle(undefined)).toBeNull();
    });
  });

  describe("renderSecurityAdvisoryIssue", () => {
    test("title carries the id; body has the facts, credits, the packages and the description", () => {
      const { title, body } = mod.renderSecurityAdvisoryIssue(advisory());

      expect(title).toBe("[GHSA-g95c-wqvr-8c3j] Admin roles can change another user's phone number");
      expect(body).toContain(
        "Mirrored from the GitHub security advisory [GHSA-g95c-wqvr-8c3j](https://github.com/octo/app/security/advisories/GHSA-g95c-wqvr-8c3j)."
      );
      expect(body).toContain("- **Severity:** Medium (CVSS 6.8)");
      expect(body).toContain("- **CVE:** CVE-2026-12345");
      expect(body).toContain("- **Weaknesses:** CWE-863");
      expect(body).toContain("- **Published:** 2026-11-03");
      expect(body).toContain("| app | npm | < 1.7.16 | 1.7.16 |");
      expect(body.endsWith("\n\n---\n\nAn admin with `user:update` can change any phone number.")).toBe(true);
      // A link, not an @mention that would ping a same-named destination user.
      expect(body).toContain("- **Credits:** [finder](https://github.com/finder) (reporter)");
      expect(body).not.toContain("@finder");
    });

    test("is the same text every time, so an unchanged advisory is never rewritten", () => {
      expect(mod.renderSecurityAdvisoryIssue(advisory())).toEqual(mod.renderSecurityAdvisoryIssue(advisory()));
    });

    test("escapes table cells and leaves out what is missing", () => {
      const { body } = mod.renderSecurityAdvisoryIssue(
        advisory({
          cve_id: null,
          cwe_ids: [],
          cvss: null,
          severity: null,
          description: "",
          credits_detailed: [],
          vulnerabilities: [{ package: { ecosystem: "pip", name: "a|b\\" }, vulnerable_version_range: ">= 1,\n< 2", patched_versions: null }],
        })
      );

      expect(body).toContain("- **Severity:** Unknown");
      expect(body).toContain("| a\\|b\\\\ | pip | >= 1, < 2 | - |");
      expect(body).not.toContain("**CVE:**");
      expect(body).not.toContain("\n---\n");
      expect(body).not.toContain("**Credits:**");
    });

    test("a withdrawn advisory says so first", () => {
      const { body } = mod.renderSecurityAdvisoryIssue(advisory({ withdrawn_at: "2026-11-20T10:00:00Z" }));
      expect(body.startsWith("> **Withdrawn** on 2026-11-20.")).toBe(true);
    });
  });

  describe("listPublishedSecurityAdvisories", () => {
    test("asks for published advisories only, and drops anything else that comes back", async () => {
      const { octokit, calls } = fakeOctokit([advisory(), advisory({ ghsa_id: "GHSA-2222-3333-4444", state: "draft" })]);

      const listed = await mod.listPublishedSecurityAdvisories(octokit, "octo", "app");

      expect(calls[0].route).toBe("GET /repos/{owner}/{repo}/security-advisories");
      expect(calls[0].params).toMatchObject({ owner: "octo", repo: "app", state: "published" });
      expect(listed.map((item) => item.ghsa_id)).toEqual(["GHSA-g95c-wqvr-8c3j"]);
    });

    test("a token that may not read advisories skips the repository", async () => {
      for (const status of [403, 404]) {
        const { octokit } = fakeOctokit([], Object.assign(new Error("nope"), { status }));
        expect(await mod.listPublishedSecurityAdvisories(octokit, "octo", "app")).toEqual([]);
      }
    });

    test("a rate limit still throws, so the sync is retried after the reset", async () => {
      const { octokit } = fakeOctokit([], Object.assign(new Error("rate limited"), { status: 429 }));
      await expect(mod.listPublishedSecurityAdvisories(octokit, "octo", "app")).rejects.toThrow("rate limited");
    });
  });

  describe("mirrorSecurityAdvisoriesToGitea", () => {
    let gitea: ReturnType<typeof fakeGitea>;
    beforeEach(() => {
      gitea = fakeGitea();
    });

    test("no advisories: the destination is not touched", async () => {
      const result = await run(fakeOctokit([]).octokit);

      expect(result).toEqual({ created: 0, updated: 0, closed: 0 });
      expect(gitea.requests).toEqual([]);
    });

    test("creates the label and one labeled issue per advisory, then leaves them alone", async () => {
      const second = advisory({ ghsa_id: "GHSA-2222-3333-4444", summary: "Second one", severity: "high" });
      const first = await run(fakeOctokit([advisory(), second]).octokit);

      expect(first).toEqual({ created: 2, updated: 0, closed: 0 });
      expect(gitea.labels.map((label) => label.name)).toEqual(["security-advisory"]);
      expect(gitea.issues.map((issue) => issue.title)).toEqual([
        "[GHSA-g95c-wqvr-8c3j] Admin roles can change another user's phone number",
        "[GHSA-2222-3333-4444] Second one",
      ]);
      expect(gitea.issues.every((issue) => issue.labels.includes(gitea.labels[0].id))).toBe(true);
      // The listing is filtered by the label, so ordinary issues are never read.
      expect(gitea.requests.find((request) => request.method === "GET" && request.path.startsWith("/issues"))?.path)
        .toContain("labels=security-advisory");

      gitea.requests.length = 0;
      const again = await run(fakeOctokit([advisory(), second]).octokit);
      expect(again).toEqual({ created: 0, updated: 0, closed: 0 });
      expect(gitea.requests.filter((request) => request.method !== "GET")).toEqual([]);
    });

    test("an edited advisory updates its issue in place", async () => {
      await run(fakeOctokit([advisory()]).octokit);

      const result = await run(fakeOctokit([advisory({ severity: "high" })]).octokit);

      expect(result).toEqual({ created: 0, updated: 1, closed: 0 });
      expect(gitea.issues).toHaveLength(1);
      expect(gitea.issues[0].body).toContain("- **Severity:** High (CVSS 6.8)");
    });

    test("a withdrawn advisory closes its issue; one never mirrored is not created", async () => {
      await run(fakeOctokit([advisory()]).octokit);

      const result = await run(
        fakeOctokit([
          advisory({ withdrawn_at: "2026-11-20T10:00:00Z" }),
          advisory({ ghsa_id: "GHSA-5555-6666-7777", withdrawn_at: "2026-11-20T10:00:00Z" }),
        ]).octokit
      );

      expect(result).toEqual({ created: 0, updated: 0, closed: 1 });
      expect(gitea.issues).toHaveLength(1);
      expect(gitea.issues[0].state).toBe("closed");
      expect(gitea.issues[0].body.startsWith("> **Withdrawn**")).toBe(true);
    });

    test("reuses an existing label and matches issues whatever the case of the id", async () => {
      gitea = fakeGitea({
        labels: [{ id: 7, name: "security-advisory" }],
        issues: [{ number: 3, title: "[GHSA-G95C-WQVR-8C3J] old title", body: "old", state: "open", labels: [7] }],
      });

      const result = await run(fakeOctokit([advisory()]).octokit);

      expect(result).toEqual({ created: 0, updated: 1, closed: 0 });
      expect(gitea.requests.some((request) => request.method === "POST" && request.path === "/labels")).toBe(false);
      expect(gitea.issues[0].title).toBe("[GHSA-g95c-wqvr-8c3j] Admin roles can change another user's phone number");
    });

    test("stops instead of creating duplicates when the existing issues cannot be listed", async () => {
      gitea = fakeGitea({ failIssueListing: true });

      await expect(run(fakeOctokit([advisory()]).octokit)).rejects.toThrow("Could not list the existing advisory issues");
      expect(gitea.requests.some((request) => request.method === "POST" && request.path === "/issues")).toBe(false);
    });
  });
});
