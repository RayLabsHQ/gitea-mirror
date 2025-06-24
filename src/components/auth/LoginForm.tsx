'use client';

import * as React from 'react';
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

import { toast, Toaster } from 'sonner';
import { showErrorToast } from '@/lib/utils';

interface AuthConfig {
  method: 'local' | 'forward' | 'oidc';
  allowLocalFallback: boolean;
  isConfigured: boolean;
  oidc?: {
    issuerUrl: string;
    clientId: string;
  };
}

export function LoginForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);

  // Load authentication configuration
  useEffect(() => {
    async function loadAuthConfig() {
      try {
        const response = await fetch('/api/auth/config');
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.config) {
            setAuthConfig(data.config);

            // Auto-redirect for forward auth if it's the primary method
            if (data.config.method === 'forward' && data.config.isConfigured) {
              // For forward auth, try to authenticate automatically
              // If headers are present, the middleware should handle it
              window.location.href = '/';
              return;
            }
          }
        }
      } catch (error) {
        console.error('Failed to load auth config:', error);
        // Fallback to local auth
        setAuthConfig({
          method: 'local',
          allowLocalFallback: false,
          isConfigured: true,
        });
      } finally {
        setConfigLoading(false);
      }
    }

    loadAuthConfig();
  }, []);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsLoading(true);
    const form = e.currentTarget;
    const formData = new FormData(form);
    const username = formData.get('username') as string | null;
    const password = formData.get('password') as string | null;

    if (!username || !password) {
      toast.error('Please enter both username and password');
      setIsLoading(false);
      return;
    }

    const loginData = { username, password };

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(loginData),
      });

      const data = await response.json();

      if (response.ok) {
        toast.success('Login successful!');
        // Small delay before redirecting to see the success message
        setTimeout(() => {
          window.location.href = '/';
        }, 1000);
      } else {
        showErrorToast(data.error || 'Login failed. Please try again.', toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleOIDCLogin() {
    setIsLoading(true);
    try {
      // Redirect to OIDC login endpoint
      window.location.href = '/api/auth/oidc/login';
    } catch (error) {
      showErrorToast(error, toast);
      setIsLoading(false);
    }
  }

  // Show loading state while config is loading
  if (configLoading) {
    return (
      <>
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <img
                src="/logo-light.svg"
                alt="Gitea Mirror Logo"
                className="h-10 w-10 dark:hidden"
              />
              <img
                src="/logo-dark.svg"
                alt="Gitea Mirror Logo"
                className="h-10 w-10 hidden dark:block"
              />
            </div>
            <CardTitle className="text-2xl">Gitea Mirror</CardTitle>
            <CardDescription>Loading authentication options...</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          </CardContent>
        </Card>
        <Toaster />
      </>
    );
  }

  // Show error if config failed to load
  if (!authConfig) {
    return (
      <>
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Authentication Error</CardTitle>
            <CardDescription>Failed to load authentication configuration</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => window.location.reload()} className="w-full">
              Retry
            </Button>
          </CardContent>
        </Card>
        <Toaster />
      </>
    );
  }

  return (
    <>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <img
              src="/logo-light.svg"
              alt="Gitea Mirror Logo"
              className="h-10 w-10 dark:hidden"
            />
            <img
              src="/logo-dark.svg"
              alt="Gitea Mirror Logo"
              className="h-10 w-10 hidden dark:block"
            />
          </div>
          <CardTitle className="text-2xl">Gitea Mirror</CardTitle>
          <CardDescription>
            Log in to manage your GitHub to Gitea mirroring
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* OIDC Login Button */}
            {authConfig.method === 'oidc' && authConfig.isConfigured && (
              <Button
                onClick={handleOIDCLogin}
                className="w-full"
                variant="outline"
                disabled={isLoading}
              >
                {isLoading ? 'Redirecting...' : 'Login with SSO'}
              </Button>
            )}

            {/* Separator if both OIDC and local are available */}
            {authConfig.method === 'oidc' && authConfig.allowLocalFallback && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">
                    Or continue with
                  </span>
                </div>
              </div>
            )}

            {/* Local Login Form */}
            {(authConfig.method === 'local' || authConfig.allowLocalFallback) && (
              <form id="login-form" onSubmit={handleLogin}>
                <div className="space-y-4">
                  <div>
                    <label htmlFor="username" className="block text-sm font-medium mb-1">
                      Username
                    </label>
                    <input
                      id="username"
                      name="username"
                      type="text"
                      required
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      placeholder="Enter your username"
                      disabled={isLoading}
                    />
                  </div>
                  <div>
                    <label htmlFor="password" className="block text-sm font-medium mb-1">
                      Password
                    </label>
                    <input
                      id="password"
                      name="password"
                      type="password"
                      required
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      placeholder="Enter your password"
                      disabled={isLoading}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? 'Logging in...' : 'Log In'}
                  </Button>
                </div>
              </form>
            )}

            {/* Forward Auth Message */}
            {authConfig.primaryMethod === 'forward' && !authConfig.methods.local && (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground">
                  Authentication is handled by your reverse proxy.
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  If you're seeing this page, please check your proxy configuration.
                </p>
              </div>
            )}
          </div>
        </CardContent>
        {authConfig.method === 'local' && (
          <div className="px-6 pb-6 text-center">
            <p className="text-sm text-muted-foreground">
              Don't have an account? Contact your administrator.
            </p>
          </div>
        )}
      </Card>
      <Toaster />
    </>
  );
}
