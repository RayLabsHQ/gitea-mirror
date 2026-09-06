import { useCallback, useEffect, useState, useRef } from 'react';
import { useAuth } from './useAuth';
import { apiRequest } from '@/lib/utils';
import type { ConfigApiResponse } from '@/types/config';
import {
  DEFAULT_SOURCE_PROVIDER,
  normalizeSourceProviderKind,
  type SourceProviderKind,
} from '@/lib/source-providers/kinds';

interface ConfigStatus {
  isGitHubConfigured: boolean;
  isGiteaConfigured: boolean;
  isFullyConfigured: boolean;
  isLoading: boolean;
  error: string | null;
  autoMirrorStarred: boolean;
  githubOwner: string;
  sourceProvider: SourceProviderKind;
}

// Cache to prevent duplicate API calls across components
let configCache: { data: ConfigApiResponse | null; timestamp: number; userId: string | null } = {
  data: null,
  timestamp: 0,
  userId: null
};

const CACHE_DURATION = 30000; // 30 seconds cache

/**
 * Hook to check if GitHub and Gitea are properly configured
 * Returns configuration status and prevents unnecessary API calls when not configured
 * Uses caching to prevent duplicate API calls across components
 */
export function useConfigStatus(): ConfigStatus {
  const { user } = useAuth();
  const [configStatus, setConfigStatus] = useState<ConfigStatus>({
    isGitHubConfigured: false,
    isGiteaConfigured: false,
    isFullyConfigured: false,
    isLoading: true,
    error: null,
    autoMirrorStarred: false,
    githubOwner: '',
    sourceProvider: DEFAULT_SOURCE_PROVIDER,
  });

  // Track if this hook has already checked config to prevent multiple calls
  const hasCheckedRef = useRef(false);

  const checkConfiguration = useCallback(async () => {
    if (!user?.id) {
      setConfigStatus({
        isGitHubConfigured: false,
        isGiteaConfigured: false,
        isFullyConfigured: false,
        isLoading: false,
        error: 'No user found',
        autoMirrorStarred: false,
        githubOwner: '',
        sourceProvider: DEFAULT_SOURCE_PROVIDER,
      });
      return;
    }

    // Check cache first
    const now = Date.now();
    const isCacheValid = configCache.data &&
                        configCache.userId === user.id &&
                        (now - configCache.timestamp) < CACHE_DURATION;

    if (isCacheValid && hasCheckedRef.current) {
      const configResponse = configCache.data!;

      // Only token/url are actually required at runtime: the GitHub token is
      // self-authenticating for listForAuthenticatedUser, and a Gitea username
      // isn't needed under single-org / flat mirror strategies. Users who
      // configure via env vars without GITHUB_USERNAME / GITEA_USERNAME set
      // (or who otherwise left those blank) were being locked out of the
      // dashboard even though mirroring worked fine (see issue #271).
      const isGitHubConfigured = !!configResponse?.githubConfig?.token;

      const isGiteaConfigured = !!(
        configResponse?.giteaConfig?.url &&
        configResponse?.giteaConfig?.token
      );

      const isFullyConfigured = isGitHubConfigured && isGiteaConfigured;

      setConfigStatus({
        isGitHubConfigured,
        isGiteaConfigured,
        isFullyConfigured,
        isLoading: false,
        error: null,
        autoMirrorStarred: configResponse?.advancedOptions?.autoMirrorStarred ?? false,
        githubOwner: configResponse?.githubConfig?.username ?? '',
        sourceProvider: normalizeSourceProviderKind(configResponse?.githubConfig?.provider),
      });
      return;
    }

    try {
      // Only show loading if we haven't checked before or cache is invalid
      if (!hasCheckedRef.current) {
        setConfigStatus(prev => ({ ...prev, isLoading: true, error: null }));
      }

      const configResponse = await apiRequest<ConfigApiResponse>(
        `/config?userId=${user.id}`,
        { method: 'GET' }
      );

      // Update cache
      configCache = {
        data: configResponse,
        timestamp: now,
        userId: user.id
      };

      // Only token/url are actually required at runtime: the GitHub token is
      // self-authenticating for listForAuthenticatedUser, and a Gitea username
      // isn't needed under single-org / flat mirror strategies. Users who
      // configure via env vars without GITHUB_USERNAME / GITEA_USERNAME set
      // (or who otherwise left those blank) were being locked out of the
      // dashboard even though mirroring worked fine (see issue #271).
      const isGitHubConfigured = !!configResponse?.githubConfig?.token;

      const isGiteaConfigured = !!(
        configResponse?.giteaConfig?.url &&
        configResponse?.giteaConfig?.token
      );

      const isFullyConfigured = isGitHubConfigured && isGiteaConfigured;

      setConfigStatus({
        isGitHubConfigured,
        isGiteaConfigured,
        isFullyConfigured,
        isLoading: false,
        error: null,
        autoMirrorStarred: configResponse?.advancedOptions?.autoMirrorStarred ?? false,
        githubOwner: configResponse?.githubConfig?.username ?? '',
        sourceProvider: normalizeSourceProviderKind(configResponse?.githubConfig?.provider),
      });

      hasCheckedRef.current = true;
    } catch (error) {
      setConfigStatus({
        isGitHubConfigured: false,
        isGiteaConfigured: false,
        isFullyConfigured: false,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to check configuration',
        autoMirrorStarred: false,
        githubOwner: '',
        sourceProvider: DEFAULT_SOURCE_PROVIDER,
      });
      hasCheckedRef.current = true;
    }
  }, [user?.id]);

  useEffect(() => {
    checkConfiguration();
  }, [checkConfiguration]);

  return configStatus;
}

// Export function to invalidate cache when config is updated
export function invalidateConfigCache() {
  configCache = { data: null, timestamp: 0, userId: null };
}

// Export function to get cached config data for other hooks
export function getCachedConfig(): ConfigApiResponse | null {
  const now = Date.now();
  const isCacheValid = configCache.data && (now - configCache.timestamp) < CACHE_DURATION;
  return isCacheValid ? configCache.data : null;
}
