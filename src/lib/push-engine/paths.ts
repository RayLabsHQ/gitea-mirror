/**
 * Where the push engine keeps its bare clones.
 *
 * One clone per repository under `<data dir>/mirrors/<source host>/<owner>/<name>.git`,
 * next to the SQLite file so a backup of the data directory carries the
 * clones too. `MIRROR_CLONE_DIR` moves the whole tree elsewhere.
 */
import path from "node:path";
import { getRepositorySource, type RepositorySourceFields } from "@/lib/source-providers/kinds";

/** The directory the SQLite database lives in, derived the same way src/lib/db does. */
export function resolveDataDir(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    return path.join(process.cwd(), "data");
  }
  const raw = url.startsWith("sqlite://")
    ? url.slice("sqlite://".length)
    : url.startsWith("file:")
      ? url.slice("file:".length)
      : url;
  return path.dirname(path.resolve(raw));
}

export function resolveMirrorCloneRoot(): string {
  const configured = process.env.MIRROR_CLONE_DIR?.trim();
  return path.resolve(configured || path.join(resolveDataDir(), "mirrors"));
}

/** Keep directory names to a safe character set; anything else becomes "_". */
export function sanitizePathSegment(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned || "_";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "unknown-host";
  }
}

export interface ClonePathInput {
  /** Base URL of the source host, e.g. https://github.com. */
  sourceUrl: string;
  owner: string;
  name: string;
}

export type CloneRepositoryFields = RepositorySourceFields & { owner: string; name: string };

/** The clone path for a stored repository row: its source host, owner and name. */
export function clonePathForRepository(repo: CloneRepositoryFields, root?: string): string {
  return clonePathFor({ sourceUrl: getRepositorySource(repo).url, owner: repo.owner, name: repo.name }, root);
}

/** Absolute path of the bare clone for a repository. */
export function clonePathFor(input: ClonePathInput, root: string = resolveMirrorCloneRoot()): string {
  return path.join(
    root,
    sanitizePathSegment(hostOf(input.sourceUrl)),
    sanitizePathSegment(input.owner),
    `${sanitizePathSegment(input.name.replace(/\.git$/i, ""))}.git`
  );
}
