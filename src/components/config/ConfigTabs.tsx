import { useEffect, useState, useCallback, useRef } from 'react';
import { GitHubConfigForm } from './GitHubConfigForm';
import { GiteaConfigForm } from './GiteaConfigForm';
import { AutomationSettings } from './AutomationSettings';
import { AuthSettings } from './AuthSettings';
import type {
  ConfigApiResponse,
  GiteaConfig,
  GitHubConfig,
  SaveConfigApiRequest,
  SaveConfigApiResponse,
  ScheduleConfig,
  DatabaseCleanupConfig,
  MirrorOptions,
  AdvancedOptions,
} from '@/types/config';
import { Button } from '../ui/button';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, showErrorToast } from '@/lib/utils';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { invalidateConfigCache } from '@/hooks/useConfigStatus';

type ConfigState = {
  githubConfig: GitHubConfig;
  giteaConfig: GiteaConfig;
  scheduleConfig: ScheduleConfig;
  cleanupConfig: DatabaseCleanupConfig;
  mirrorOptions: MirrorOptions;
  advancedOptions: AdvancedOptions;
};

export function ConfigTabs() {
  const [config, setConfig] = useState<ConfigState>({
    githubConfig: {
      username: '',
      token: '',
      privateRepositories: false,
      mirrorStarred: false,
    },
    giteaConfig: {
      url: '',
      username: '',
      token: '',
      organization: 'github-mirrors',
      visibility: 'public',
      starredReposOrg: 'github',
      preserveOrgStructure: false,
    },
    scheduleConfig: {
      enabled: false,
      interval: 3600,
    },
    cleanupConfig: {
      enabled: false,
      retentionDays: 604800, // 7 days in seconds
    },
    mirrorOptions: {
      mirrorReleases: false,
      mirrorMetadata: false,
      metadataComponents: {
        issues: false,
        pullRequests: false,
        labels: false,
        milestones: false,
        wiki: false,
      },
    },
    advancedOptions: {
      skipForks: false,
      skipStarredIssues: false,
    },
  });
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  const [isAutoSavingSchedule, setIsAutoSavingSchedule] = useState<boolean>(false);
  const [isAutoSavingCleanup, setIsAutoSavingCleanup] = useState<boolean>(false);
  const [isAutoSavingGitHub, setIsAutoSavingGitHub] = useState<boolean>(false);
  const [isAutoSavingGitea, setIsAutoSavingGitea] = useState<boolean>(false);
  const autoSaveScheduleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoSaveCleanupTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoSaveGitHubTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoSaveGiteaTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isConfigFormValid = (): boolean => {
    const { githubConfig, giteaConfig } = config;
    const isGitHubValid = !!(
      githubConfig.username.trim() && githubConfig.token.trim()
    );
    const isGiteaValid = !!(
      giteaConfig.url.trim() &&
      giteaConfig.username.trim() &&
      giteaConfig.token.trim()
    );
    return isGitHubValid && isGiteaValid;
  };

  const isGitHubConfigValid = (): boolean => {
    const { githubConfig } = config;
    return !!(githubConfig.username.trim() && githubConfig.token.trim());
  };

  // Removed the problematic useEffect that was causing circular dependencies
  // The lastRun and nextRun should be managed by the backend and fetched via API

  const handleImportGitHubData = async () => {
    if (!user?.id) return;
    setIsSyncing(true);
    try {
      const result = await apiRequest<{ success: boolean; message?: string }>(
        `/sync?userId=${user.id}`,
        { method: 'POST' },
      );
      result.success
        ? toast.success(
            'GitHub data imported successfully! Head to the Repositories page to start mirroring.',
          )
        : toast.error(
            `Failed to import GitHub data: ${
              result.message || 'Unknown error'
            }`,
          );
    } catch (error) {
      toast.error(
        `Error importing GitHub data: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setIsSyncing(false);
    }
  };

  // Auto-save function specifically for schedule config changes
  const autoSaveScheduleConfig = useCallback(async (scheduleConfig: ScheduleConfig) => {
    if (!user?.id) return;

    // Clear any existing timeout
    if (autoSaveScheduleTimeoutRef.current) {
      clearTimeout(autoSaveScheduleTimeoutRef.current);
    }

    // Debounce the auto-save to prevent excessive API calls
    autoSaveScheduleTimeoutRef.current = setTimeout(async () => {
      setIsAutoSavingSchedule(true);

      const reqPayload: SaveConfigApiRequest = {
        userId: user.id!,
        githubConfig: config.githubConfig,
        giteaConfig: config.giteaConfig,
        scheduleConfig: scheduleConfig,
        cleanupConfig: config.cleanupConfig,
        mirrorOptions: config.mirrorOptions,
        advancedOptions: config.advancedOptions,
      };

      try {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqPayload),
        });
        const result: SaveConfigApiResponse = await response.json();

        if (result.success) {
          // Silent success - no toast for auto-save
          // Removed refreshUser() call to prevent page reload
          // Invalidate config cache so other components get fresh data
          invalidateConfigCache();

          // Fetch updated config to get the recalculated nextRun time
          try {
            const updatedResponse = await apiRequest<ConfigApiResponse>(
              `/config?userId=${user.id}`,
              { method: 'GET' },
            );
            if (updatedResponse && !updatedResponse.error) {
              setConfig(prev => ({
                ...prev,
                scheduleConfig: updatedResponse.scheduleConfig || prev.scheduleConfig,
              }));
            }
          } catch (fetchError) {
            console.warn('Failed to fetch updated config after auto-save:', fetchError);
          }
        } else {
          showErrorToast(
            `Auto-save failed: ${result.message || 'Unknown error'}`,
            toast
          );
        }
      } catch (error) {
        showErrorToast(error, toast);
      } finally {
        setIsAutoSavingSchedule(false);
      }
    }, 500); // 500ms debounce
  }, [user?.id, config.githubConfig, config.giteaConfig, config.cleanupConfig]);

  // Auto-save function specifically for cleanup config changes
  const autoSaveCleanupConfig = useCallback(async (cleanupConfig: DatabaseCleanupConfig) => {
    if (!user?.id) return;

    // Clear any existing timeout
    if (autoSaveCleanupTimeoutRef.current) {
      clearTimeout(autoSaveCleanupTimeoutRef.current);
    }

    // Debounce the auto-save to prevent excessive API calls
    autoSaveCleanupTimeoutRef.current = setTimeout(async () => {
      setIsAutoSavingCleanup(true);

      const reqPayload: SaveConfigApiRequest = {
        userId: user.id!,
        githubConfig: config.githubConfig,
        giteaConfig: config.giteaConfig,
        scheduleConfig: config.scheduleConfig,
        cleanupConfig: cleanupConfig,
        mirrorOptions: config.mirrorOptions,
        advancedOptions: config.advancedOptions,
      };

      try {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqPayload),
        });
        const result: SaveConfigApiResponse = await response.json();

        if (result.success) {
          // Silent success - no toast for auto-save
          // Invalidate config cache so other components get fresh data
          invalidateConfigCache();

          // Fetch updated config to get the recalculated nextRun time
          try {
            const updatedResponse = await apiRequest<ConfigApiResponse>(
              `/config?userId=${user.id}`,
              { method: 'GET' },
            );
            if (updatedResponse && !updatedResponse.error) {
              setConfig(prev => ({
                ...prev,
                cleanupConfig: updatedResponse.cleanupConfig || prev.cleanupConfig,
              }));
            }
          } catch (fetchError) {
            console.warn('Failed to fetch updated config after auto-save:', fetchError);
          }
        } else {
          showErrorToast(
            `Auto-save failed: ${result.message || 'Unknown error'}`,
            toast
          );
        }
      } catch (error) {
        showErrorToast(error, toast);
      } finally {
        setIsAutoSavingCleanup(false);
      }
    }, 500); // 500ms debounce
  }, [user?.id, config.githubConfig, config.giteaConfig, config.scheduleConfig]);

  // Auto-save function specifically for GitHub config changes
  const autoSaveGitHubConfig = useCallback(async (githubConfig: GitHubConfig) => {
    if (!user?.id) return;

    // Clear any existing timeout
    if (autoSaveGitHubTimeoutRef.current) {
      clearTimeout(autoSaveGitHubTimeoutRef.current);
    }

    // Debounce the auto-save to prevent excessive API calls
    autoSaveGitHubTimeoutRef.current = setTimeout(async () => {
      setIsAutoSavingGitHub(true);

      const reqPayload: SaveConfigApiRequest = {
        userId: user.id!,
        githubConfig: githubConfig,
        giteaConfig: config.giteaConfig,
        scheduleConfig: config.scheduleConfig,
        cleanupConfig: config.cleanupConfig,
        mirrorOptions: config.mirrorOptions,
        advancedOptions: config.advancedOptions,
      };

      try {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqPayload),
        });
        const result: SaveConfigApiResponse = await response.json();

        if (result.success) {
          // Silent success - no toast for auto-save
          // Invalidate config cache so other components get fresh data
          invalidateConfigCache();
        } else {
          showErrorToast(
            `Auto-save failed: ${result.message || 'Unknown error'}`,
            toast
          );
        }
      } catch (error) {
        showErrorToast(error, toast);
      } finally {
        setIsAutoSavingGitHub(false);
      }
    }, 500); // 500ms debounce
  }, [user?.id, config.giteaConfig, config.scheduleConfig, config.cleanupConfig]);

  // Auto-save function specifically for Gitea config changes
  const autoSaveGiteaConfig = useCallback(async (giteaConfig: GiteaConfig) => {
    if (!user?.id) return;

    // Clear any existing timeout
    if (autoSaveGiteaTimeoutRef.current) {
      clearTimeout(autoSaveGiteaTimeoutRef.current);
    }

    // Debounce the auto-save to prevent excessive API calls
    autoSaveGiteaTimeoutRef.current = setTimeout(async () => {
      setIsAutoSavingGitea(true);

      const reqPayload: SaveConfigApiRequest = {
        userId: user.id!,
        githubConfig: config.githubConfig,
        giteaConfig: giteaConfig,
        scheduleConfig: config.scheduleConfig,
        cleanupConfig: config.cleanupConfig,
        mirrorOptions: config.mirrorOptions,
        advancedOptions: config.advancedOptions,
      };

      try {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqPayload),
        });
        const result: SaveConfigApiResponse = await response.json();

        if (result.success) {
          // Silent success - no toast for auto-save
          // Invalidate config cache so other components get fresh data
          invalidateConfigCache();
        } else {
          showErrorToast(
            `Auto-save failed: ${result.message || 'Unknown error'}`,
            toast
          );
        }
      } catch (error) {
        showErrorToast(error, toast);
      } finally {
        setIsAutoSavingGitea(false);
      }
    }, 500); // 500ms debounce
  }, [user?.id, config.githubConfig, config.scheduleConfig, config.cleanupConfig]);

  // Auto-save function for mirror options (handled within GitHub config)
  const autoSaveMirrorOptions = useCallback(async (mirrorOptions: MirrorOptions) => {
    if (!user?.id) return;

    const reqPayload: SaveConfigApiRequest = {
      userId: user.id!,
      githubConfig: config.githubConfig,
      giteaConfig: config.giteaConfig,
      scheduleConfig: config.scheduleConfig,
      cleanupConfig: config.cleanupConfig,
      mirrorOptions: mirrorOptions,
      advancedOptions: config.advancedOptions,
    };

    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqPayload),
      });
      const result: SaveConfigApiResponse = await response.json();

      if (result.success) {
        invalidateConfigCache();
      } else {
        showErrorToast(
          `Auto-save failed: ${result.message || 'Unknown error'}`,
          toast
        );
      }
    } catch (error) {
      showErrorToast(error, toast);
    }
  }, [user?.id, config.githubConfig, config.giteaConfig, config.scheduleConfig, config.cleanupConfig, config.advancedOptions]);

  // Auto-save function for advanced options (handled within GitHub config)
  const autoSaveAdvancedOptions = useCallback(async (advancedOptions: AdvancedOptions) => {
    if (!user?.id) return;

    const reqPayload: SaveConfigApiRequest = {
      userId: user.id!,
      githubConfig: config.githubConfig,
      giteaConfig: config.giteaConfig,
      scheduleConfig: config.scheduleConfig,
      cleanupConfig: config.cleanupConfig,
      mirrorOptions: config.mirrorOptions,
      advancedOptions: advancedOptions,
    };

    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqPayload),
      });
      const result: SaveConfigApiResponse = await response.json();

      if (result.success) {
        invalidateConfigCache();
      } else {
        showErrorToast(
          `Auto-save failed: ${result.message || 'Unknown error'}`,
          toast
        );
      }
    } catch (error) {
      showErrorToast(error, toast);
    }
  }, [user?.id, config.githubConfig, config.giteaConfig, config.scheduleConfig, config.cleanupConfig, config.mirrorOptions]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (autoSaveScheduleTimeoutRef.current) {
        clearTimeout(autoSaveScheduleTimeoutRef.current);
      }
      if (autoSaveCleanupTimeoutRef.current) {
        clearTimeout(autoSaveCleanupTimeoutRef.current);
      }
      if (autoSaveGitHubTimeoutRef.current) {
        clearTimeout(autoSaveGitHubTimeoutRef.current);
      }
      if (autoSaveGiteaTimeoutRef.current) {
        clearTimeout(autoSaveGiteaTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!user?.id) return;

    const fetchConfig = async () => {
      setIsLoading(true);
      try {
        const response = await apiRequest<ConfigApiResponse>(
          `/config?userId=${user.id}`,
          { method: 'GET' },
        );
        if (response && !response.error) {
          setConfig({
            githubConfig:
              response.githubConfig || config.githubConfig,
            giteaConfig:
              response.giteaConfig || config.giteaConfig,
            scheduleConfig:
              response.scheduleConfig || config.scheduleConfig,
            cleanupConfig:
              response.cleanupConfig || config.cleanupConfig,
            mirrorOptions:
              response.mirrorOptions || config.mirrorOptions,
            advancedOptions:
              response.advancedOptions || config.advancedOptions,
          });

        }
      } catch (error) {
        console.warn(
          'Could not fetch configuration, using defaults:',
          error,
        );
      }
      setIsLoading(false);
    };

    fetchConfig();
  }, [user?.id]); // Only depend on user.id, not the entire user object

  function ConfigCardSkeleton() {
    return (
      <div className="space-y-6">
        {/* Header section */}
        <div className="flex flex-row justify-between items-start">
          <div className="flex flex-col gap-y-1.5">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="flex gap-x-4">
            <Skeleton className="h-10 w-36" />
          </div>
        </div>

        {/* Content section - Grid layout */}
        <div className="space-y-4">
          {/* GitHub & Gitea connections - Side by side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border rounded-lg p-4">
              <div className="flex justify-between items-center mb-4">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-9 w-32" />
              </div>
              <div className="space-y-4">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-1 w-full" />
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-48 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            </div>
            <div className="border rounded-lg p-4">
              <div className="flex justify-between items-center mb-4">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-9 w-32" />
              </div>
              <div className="space-y-4">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            </div>
          </div>

          {/* Automation & Maintenance - Full width */}
          <div className="border rounded-lg p-4">
            <Skeleton className="h-8 w-48 mb-4" />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-4">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
              <div className="space-y-4">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return isLoading ? (
    <div className="space-y-6">
      <ConfigCardSkeleton />
    </div>
  ) : (
    <div className="space-y-6">
      {/* Header section */}
      <div className="flex flex-row justify-between items-start">
        <div className="flex flex-col gap-y-1.5">
          <h1 className="text-2xl font-semibold leading-none tracking-tight">
            Configuration Settings
          </h1>
          <p className="text-sm text-muted-foreground">
            Configure your GitHub and Gitea connections, and set up automatic
            mirroring.
          </p>
        </div>
        <div className="flex gap-x-4">
          <Button
            onClick={handleImportGitHubData}
            disabled={isSyncing || !isGitHubConfigValid()}
            title={
              !isGitHubConfigValid()
                ? 'Please fill GitHub username and token fields'
                : isSyncing
                ? 'Import in progress'
                : 'Import GitHub Data'
            }
          >
            {isSyncing ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin mr-1" />
                Import GitHub Data
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-1" />
                Import GitHub Data
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Content section - Grid layout */}
      <div className="space-y-6">
        {/* GitHub & Gitea connections - Side by side */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:items-stretch">
          <GitHubConfigForm
            config={config.githubConfig}
            setConfig={update =>
              setConfig(prev => ({
                ...prev,
                githubConfig:
                  typeof update === 'function'
                    ? update(prev.githubConfig)
                    : update,
              }))
            }
            mirrorOptions={config.mirrorOptions}
            setMirrorOptions={update =>
              setConfig(prev => ({
                ...prev,
                mirrorOptions:
                  typeof update === 'function'
                    ? update(prev.mirrorOptions)
                    : update,
              }))
            }
            advancedOptions={config.advancedOptions}
            setAdvancedOptions={update =>
              setConfig(prev => ({
                ...prev,
                advancedOptions:
                  typeof update === 'function'
                    ? update(prev.advancedOptions)
                    : update,
              }))
            }
            onAutoSave={autoSaveGitHubConfig}
            onMirrorOptionsAutoSave={autoSaveMirrorOptions}
            onAdvancedOptionsAutoSave={autoSaveAdvancedOptions}
            isAutoSaving={isAutoSavingGitHub}
          />
          <GiteaConfigForm
            config={config.giteaConfig}
            setConfig={update =>
              setConfig(prev => ({
                ...prev,
                giteaConfig:
                  typeof update === 'function'
                    ? update(prev.giteaConfig)
                    : update,
              }))
            }
            onAutoSave={autoSaveGiteaConfig}
            isAutoSaving={isAutoSavingGitea}
            githubUsername={config.githubConfig.username}
          />
        </div>

        {/* Automation & Maintenance - Full width */}
        <div>
          <AutomationSettings
            scheduleConfig={config.scheduleConfig}
            cleanupConfig={config.cleanupConfig}
            onScheduleChange={(newConfig) => {
              setConfig(prev => ({ ...prev, scheduleConfig: newConfig }));
              autoSaveScheduleConfig(newConfig);
            }}
            onCleanupChange={(newConfig) => {
              setConfig(prev => ({ ...prev, cleanupConfig: newConfig }));
              autoSaveCleanupConfig(newConfig);
            }}
            isAutoSavingSchedule={isAutoSavingSchedule}
            isAutoSavingCleanup={isAutoSavingCleanup}
          />
        </div>

        {/* Authentication Settings - Full width */}
        <div>
          <AuthSettings />
        </div>
      </div>
    </div>
  );
}
