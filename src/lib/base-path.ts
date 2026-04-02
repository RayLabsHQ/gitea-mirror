const URL_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

function normalizeBasePath(basePath: string | null | undefined): string {
  if (!basePath) {
    return "/";
  }

  let normalized = basePath.trim();
  if (!normalized) {
    return "/";
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/+$/, "");
  return normalized || "/";
}

const rawBasePath =
  (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) ||
  process.env.BASE_URL ||
  "/";

export const BASE_PATH = normalizeBasePath(rawBasePath);

export function withBase(path: string): string {
  if (!path) {
    return BASE_PATH === "/" ? "/" : `${BASE_PATH}/`;
  }

  if (URL_SCHEME_REGEX.test(path) || path.startsWith("//")) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (BASE_PATH === "/") {
    return normalizedPath;
  }

  return `${BASE_PATH}${normalizedPath}`;
}

export function stripBasePath(pathname: string): string {
  if (!pathname) {
    return "/";
  }

  if (BASE_PATH === "/") {
    return pathname;
  }

  if (pathname === BASE_PATH || pathname === `${BASE_PATH}/`) {
    return "/";
  }

  if (pathname.startsWith(`${BASE_PATH}/`)) {
    return pathname.slice(BASE_PATH.length) || "/";
  }

  return pathname;
}
