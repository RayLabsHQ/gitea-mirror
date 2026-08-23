import type { MirrorPair, Server, ServerType } from "@/lib/db/schema";

export const SERVER_TYPE_LABELS: Record<ServerType, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
  forgejo: "Forgejo",
  git: "Git",
};

/** A mirror pair as returned by GET /api/matrix (with embedded server summaries). */
export interface MirrorPairWithServers extends MirrorPair {
  sourceServer: { id: string; name: string; type: ServerType; url: string };
  targetServer: { id: string; name: string; type: ServerType; url: string };
}

export interface ServersApiResponse {
  servers: Server[];
}

export interface ServerApiResponse {
  success: boolean;
  message: string;
  server?: Server;
}

export interface MatrixApiResponse {
  pairs: MirrorPairWithServers[];
}

export interface MatrixPairApiResponse {
  success: boolean;
  message: string;
  pair?: MirrorPairWithServers;
}

/** Distinct usernames among the user's servers of a given type. */
export function usernamesForType(servers: Server[], type: ServerType): string[] {
  return Array.from(
    new Set(servers.filter((s) => s.type === type).map((s) => s.username))
  );
}
