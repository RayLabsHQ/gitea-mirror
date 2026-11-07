/**
 * Where the SQLite database lives, from DATABASE_URL.
 *
 * gitea-mirror only runs on SQLite. DATABASE_URL takes the sqlite:// scheme,
 * the legacy file: scheme or a plain path, and a relative path resolves
 * against the working directory. Any other scheme, such as postgresql://, is
 * ignored with a warning. From v3.25.0 such a URL was read as a file path,
 * which opened a new, empty database outside the data volume (#502); before
 * that the variable was not read at all, so the default is where those
 * setups keep their data.
 *
 * Kept apart from ./index, which tests replace with mock.module.
 */
import path from "node:path";

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "gitea-mirror.db");
}

let warnedScheme: string | undefined;

export function resolveDbPath(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    return defaultDbPath();
  }
  if (url.startsWith("sqlite://")) {
    return path.resolve(url.slice("sqlite://".length));
  }
  if (url.startsWith("file:")) {
    return path.resolve(url.slice("file:".length));
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1];
  if (scheme) {
    const fallback = defaultDbPath();
    // Name only the scheme: the rest of the URL can hold a password.
    if (warnedScheme !== scheme) {
      warnedScheme = scheme;
      console.warn(
        `[DB] DATABASE_URL uses ${scheme}://, but gitea-mirror only supports SQLite. ` +
          `Ignoring it and using ${fallback}. Remove DATABASE_URL or set it to file:data/gitea-mirror.db.`
      );
    }
    return fallback;
  }

  return path.resolve(url);
}
