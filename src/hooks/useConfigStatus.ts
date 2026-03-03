import { useCallback, useEffect, useState, useRef } from 'react';
import { useAuth } from './useAuth';
import { apiRequest } from '@/lib/utils';
import type { ConfigApiResponse } from '@/types/config';

interface ConfigStatus {
  isGitHubConfigured: boolean;
  isGiteaConfigured: boolean;
  isFullyConfigured: boolean;
  isLoading: boolean;
  error: string | null;
  autoMirrorStarred: boolean;
  githubOwner: string;
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

      const isGitHubConfigured = !!(
        configResponse?.githubConfig?.username &&
        configResponse?.githubConfig?.token
      );

      const isGiteaConfigured = !!(
        configResponse?.giteaConfig?.url &&
        configResponse?.giteaConfig?.username &&
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

      const isGitHubConfigured = !!(
        configResponse?.githubConfig?.username &&
        configResponse?.githubConfig?.token
      );

      const isGiteaConfigured = !!(
        configResponse?.giteaConfig?.url &&
        configResponse?.giteaConfig?.username &&
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
