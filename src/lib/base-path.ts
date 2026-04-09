const URL_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const BASE_PATH_WINDOW_KEY = "__GITEA_MIRROR_BASE_PATH__";

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

function resolveRuntimeBasePath(): string {
  if (typeof process !== "undefined" && typeof process.env?.BASE_URL === "string") {
    return normalizeBasePath(process.env.BASE_URL);
  }

  if (typeof window !== "undefined") {
    const runtimeBasePath = (window as Window & { [BASE_PATH_WINDOW_KEY]?: string })[BASE_PATH_WINDOW_KEY];
    if (typeof runtimeBasePath === "string") {
      return normalizeBasePath(runtimeBasePath);
    }
  }

  return "/";
}

export function getBasePath(): string {
  return resolveRuntimeBasePath();
}

export const BASE_PATH = getBasePath();
export { BASE_PATH_WINDOW_KEY };

export function withBase(path: string): string {
  const basePath = getBasePath();

  if (!path) {
    return basePath === "/" ? "/" : `${basePath}/`;
  }

  if (URL_SCHEME_REGEX.test(path) || path.startsWith("//")) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (basePath === "/") {
    return normalizedPath;
  }

  return `${basePath}${normalizedPath}`;
}

export function stripBasePath(pathname: string): string {
  const basePath = getBasePath();

  if (!pathname) {
    return "/";
  }

  if (basePath === "/") {
    return pathname;
  }

  if (pathname === basePath || pathname === `${basePath}/`) {
    return "/";
  }

  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || "/";
  }

  return pathname;
}
