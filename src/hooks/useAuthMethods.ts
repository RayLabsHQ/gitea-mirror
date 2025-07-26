import { useState, useEffect } from 'react';
import { apiRequest } from '@/lib/utils';

interface AuthMethods {
  emailPassword: boolean;
  sso: {
    enabled: boolean;
    providers: Array<{
      id: string;
      providerId: string;
      domain: string;
    }>;
  };
  oidc: {
    enabled: boolean;
  };
}

export function useAuthMethods() {
  const [authMethods, setAuthMethods] = useState<AuthMethods>({
    emailPassword: true,
    sso: {
      enabled: false,
      providers: [],
    },
    oidc: {
      enabled: false,
    },
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadAuthMethods();
  }, []);

  const loadAuthMethods = async () => {
    try {
      // Check SSO providers - use public endpoint since this is used on login page
      const providers = await apiRequest<any[]>('/sso/providers/public').catch(() => []);
      const applications = await apiRequest<any[]>('/sso/applications').catch(() => []);

      setAuthMethods({
        emailPassword: true, // Always enabled
        sso: {
          enabled: providers.length > 0,
          providers: providers.map(p => ({
            id: p.id,
            providerId: p.providerId,
            domain: p.domain,
          })),
        },
        oidc: {
          enabled: applications.length > 0,
        },
      });
    } catch (error) {
      // If we can't load auth methods, default to email/password only
      console.error('Failed to load auth methods:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return { authMethods, isLoading };
}