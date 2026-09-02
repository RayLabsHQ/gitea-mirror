import type { PushDestinationKind } from "@/lib/destination-kinds";
import { GitHubPushTarget } from "./github";
import { GitLabPushTarget } from "./gitlab";
import type { PushTarget, PushTargetConnection } from "./types";

export * from "./types";
export { GitHubPushTarget, githubApiRootFor } from "./github";
export { GitLabPushTarget } from "./gitlab";
export { isTargetNotFound } from "./http";

export function createPushTarget(kind: PushDestinationKind, connection: PushTargetConnection): PushTarget {
  switch (kind) {
    case "gitlab":
      return new GitLabPushTarget(connection);
    case "github":
    default:
      return new GitHubPushTarget(connection);
  }
}
