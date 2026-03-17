interface GiteaUrlConfig {
  url?: string | null;
  externalUrl?: string | null;
}

export function getGiteaWebBaseUrl(
  config?: GiteaUrlConfig | null
): string | null {
  const rawBaseUrl = config?.externalUrl || config?.url;
  if (!rawBaseUrl) {
    return null;
  }

  return rawBaseUrl.endsWith("/") ? rawBaseUrl.slice(0, -1) : rawBaseUrl;
}

export function buildGiteaWebUrl(
  config: GiteaUrlConfig | null | undefined,
  path: string
): string | null {
  const baseUrl = getGiteaWebBaseUrl(config);
  if (!baseUrl) {
    return null;
  }

  const normalizedPath = path.replace(/^\/+/, "");
  return normalizedPath ? `${baseUrl}/${normalizedPath}` : baseUrl;
}
