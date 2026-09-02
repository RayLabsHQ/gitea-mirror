/**
 * Which path a destination takes: Gitea and Forgejo through the pull
 * mirror functions, GitHub and GitLab through the push engine.
 */
import { describe, expect, mock, test } from "bun:test";
import { createMirrorDispatcher, resolveMirrorTransport, type MirrorDispatchDeps } from "./mirror-dispatch";

function deps() {
  return {
    push: mock<MirrorDispatchDeps["push"]>(async () => "push"),
    giteaMirror: mock<MirrorDispatchDeps["giteaMirror"]>(async () => "gitea-mirror"),
    giteaOrgMirror: mock<MirrorDispatchDeps["giteaOrgMirror"]>(async () => "gitea-org-mirror"),
    giteaSync: mock<MirrorDispatchDeps["giteaSync"]>(async () => "gitea-sync"),
  } satisfies MirrorDispatchDeps;
}

const repository = { id: "r1", name: "tool", fullName: "acme/tool", owner: "acme" } as any;

function configFor(provider: string | undefined) {
  return { userId: "u1", giteaConfig: { provider, url: "https://example.com", token: "t", defaultOwner: "me" } } as any;
}

describe("resolveMirrorTransport", () => {
  test("pull for Gitea and Forgejo, push for GitHub and GitLab, pull when unset", () => {
    expect(resolveMirrorTransport(configFor("gitea"))).toBe("pull");
    expect(resolveMirrorTransport(configFor("forgejo"))).toBe("pull");
    expect(resolveMirrorTransport(configFor("github"))).toBe("push");
    expect(resolveMirrorTransport(configFor("gitlab"))).toBe("push");
    expect(resolveMirrorTransport(configFor(undefined))).toBe("pull");
    expect(resolveMirrorTransport(undefined)).toBe("pull");
  });
});

describe("mirror dispatcher", () => {
  test("mirror to Gitea goes to the user path without an organization", async () => {
    const d = deps();
    const dispatcher = createMirrorDispatcher(d);
    await dispatcher.mirror({ config: configFor("gitea"), octokit: null, repository });
    expect(d.giteaMirror).toHaveBeenCalledTimes(1);
    expect(d.giteaOrgMirror).not.toHaveBeenCalled();
    expect(d.push).not.toHaveBeenCalled();
  });

  test("mirror to Forgejo with an organization goes to the org path", async () => {
    const d = deps();
    const dispatcher = createMirrorDispatcher(d);
    await dispatcher.mirror({ config: configFor("forgejo"), octokit: null, repository, orgName: "acme", giteaOrgId: 3 });
    expect(d.giteaOrgMirror).toHaveBeenCalledTimes(1);
    expect(d.giteaOrgMirror.mock.calls[0][0]).toMatchObject({ orgName: "acme", giteaOrgId: 3 });
    expect(d.giteaMirror).not.toHaveBeenCalled();
  });

  test("mirror to GitHub goes to the push engine even when an organization is given", async () => {
    const d = deps();
    const dispatcher = createMirrorDispatcher(d);
    await dispatcher.mirror({ config: configFor("github"), octokit: null, repository, orgName: "acme" });
    expect(d.push).toHaveBeenCalledTimes(1);
    expect(d.push.mock.calls[0][0]).toMatchObject({ repository, mode: "mirror" });
    expect(d.giteaMirror).not.toHaveBeenCalled();
    expect(d.giteaOrgMirror).not.toHaveBeenCalled();
  });

  test("sync routes by destination too", async () => {
    const d = deps();
    const dispatcher = createMirrorDispatcher(d);
    await dispatcher.sync({ config: configFor("gitlab"), repository });
    await dispatcher.sync({ config: configFor("gitea"), repository });
    expect(d.push).toHaveBeenCalledTimes(1);
    expect(d.push.mock.calls[0][0]).toMatchObject({ mode: "sync" });
    expect(d.giteaSync).toHaveBeenCalledTimes(1);
  });
});
