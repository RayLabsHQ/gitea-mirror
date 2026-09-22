import { useState, useEffect } from 'react';
import { apiRequest } from '@/lib/utils';
import {
  DEFAULT_AUTH_METHOD,
  parseDefaultAuthMethod,
  type AuthMethod,
} from '@/lib/utils/auth-method';

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
  /** Instance default from AUTH_DEFAULT_METHOD, used when nothing is remembered. */
  defaultMethod: AuthMethod;
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
    defaultMethod: DEFAULT_AUTH_METHOD,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadAuthMethods();
  }, []);

  const loadAuthMethods = async () => {
    try {
      // Public endpoint: the login page calls it before anyone is signed in.
      const methods = await apiRequest<Partial<AuthMethods>>('/auth/methods');
      const providers = methods.sso?.providers ?? [];

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
          enabled: methods.oidc?.enabled === true,
        },
        defaultMethod: parseDefaultAuthMethod(methods.defaultMethod),
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
