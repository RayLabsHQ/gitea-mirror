/**
 * Regression test for #334 — "Release titles not being mirrored properly".
 *
 * Root cause: the release create/update payloads sent the release title under the
 * JSON key `title`, but Gitea/Forgejo's release API expects `name` (the API Go
 * struct is `Title string \`json:"name"\``). `title` is silently dropped, so every
 * mirrored release landed with a blank name.
 *
 * `buildGiteaReleasePayload` is the single source of truth for both the create
 * (POST) and update (PATCH) bodies. Verified live against Gitea 1.24.7: a payload
 * with `title` yields `name: ""`; a payload with `name` sets the title correctly.
 */

import { describe, test, expect } from "bun:test";
import { buildGiteaReleasePayload } from "@/lib/gitea";

describe("buildGiteaReleasePayload (#334)", () => {
  test("carries the release title under `name`, never `title`", () => {
    const payload = buildGiteaReleasePayload(
      { tag_name: "v0.19.0", name: "v0.19.0", draft: false, prerelease: false },
      "## Features\n- something"
    );

    expect(payload.name).toBe("v0.19.0");
    expect(payload).not.toHaveProperty("title");
    expect(payload).toEqual({
      tag_name: "v0.19.0",
      name: "v0.19.0",
      body: "## Features\n- something",
      draft: false,
      prerelease: false,
    });
  });

  test("falls back to tag_name when the GitHub release name is empty or null", () => {
    expect(buildGiteaReleasePayload({ tag_name: "v1.2.3", name: null }, "x").name).toBe("v1.2.3");
    expect(buildGiteaReleasePayload({ tag_name: "v1.2.3", name: "" }, "x").name).toBe("v1.2.3");
    expect(buildGiteaReleasePayload({ tag_name: "v1.2.3" }, "x").name).toBe("v1.2.3");
  });

  test("passes draft/prerelease/body through unchanged", () => {
    const payload = buildGiteaReleasePayload(
      { tag_name: "v2.0.0", name: "Two", draft: true, prerelease: true },
      "notes body"
    );
    expect(payload.body).toBe("notes body");
    expect(payload.draft).toBe(true);
    expect(payload.prerelease).toBe(true);
    expect(payload.tag_name).toBe("v2.0.0");
  });
});
