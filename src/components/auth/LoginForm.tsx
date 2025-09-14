'use client';

import * as React from 'react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { useAuthMethods } from '@/hooks/useAuthMethods';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { authClient } from '@/lib/auth-client';
import { Separator } from '@/components/ui/separator';
import { toast, Toaster } from 'sonner';
import { showErrorToast } from '@/lib/utils';
import { Loader2, Mail, Globe, Eye, EyeOff } from 'lucide-react';


export function LoginForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [ssoEmail, setSsoEmail] = useState('');
  const { login } = useAuth();
  const { authMethods, isLoading: isLoadingMethods } = useAuthMethods();

  // Determine which tab to show by default
  const getDefaultTab = () => {
    if (authMethods.emailPassword) return 'email';
    if (authMethods.sso.enabled) return 'sso';
    return 'email'; // fallback
  };

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsLoading(true);
    const form = e.currentTarget;
    const formData = new FormData(form);
    const email = formData.get('email') as string | null;
    const password = formData.get('password') as string | null;

    if (!email || !password) {
      toast.error('Please enter both email and password');
      setIsLoading(false);
      return;
    }

    try {
      await login(email, password);
      toast.success('Login successful!');
      // Small delay before redirecting to see the success message
      setTimeout(() => {
        window.location.href = '/';
      }, 1000);
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSSOLogin(domain?: string, providerId?: string) {
    setIsLoading(true);
    try {
      if (!domain && !ssoEmail) {
        toast.error('Please enter your email or select a provider');
        return;
      }

      const baseURL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4321';
      await authClient.signIn.sso({
        email: ssoEmail || undefined,
        domain: domain,
        providerId: providerId,
        callbackURL: `${baseURL}/`,
        errorCallbackURL: `${baseURL}/auth-error`,
        newUserCallbackURL: `${baseURL}/`,
        scopes: ['openid', 'email', 'profile'], // TODO: This is not being respected by the SSO plugin.
      });
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <img
              src="/logo.png"
              alt="Gitea Mirror Logo"
              className="h-8 w-10"
            />
          </div>
          <CardTitle className="text-2xl">Gitea Mirror</CardTitle>
          <CardDescription>
            Log in to manage your GitHub to Gitea mirroring
          </CardDescription>
        </CardHeader>
        
        {isLoadingMethods ? (
          <CardContent>
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          </CardContent>
        ) : (
          <>
            {/* Show tabs only if multiple auth methods are available */}
            {authMethods.sso.enabled && authMethods.emailPassword ? (
              <Tabs defaultValue={getDefaultTab()} className="w-full">
                <TabsList className="grid w-full grid-cols-2 mx-6" style={{ width: 'calc(100% - 3rem)' }}>
                  <TabsTrigger value="email">
                    <Mail className="h-4 w-4 mr-2" />
                    Email
                  </TabsTrigger>
                  <TabsTrigger value="sso">
                    <Globe className="h-4 w-4 mr-2" />
                    SSO
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="email">
                  <CardContent>
                    <form id="login-form" onSubmit={handleLogin}>
                      <div className="space-y-4">
                        <div>
                          <label htmlFor="email" className="block text-sm font-medium mb-1">
                            Email
                          </label>
                          <input
                            id="email"
                            name="email"
                            type="email"
                            required
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            placeholder="Enter your email"
                            disabled={isLoading}
                          />
                        </div>
                        <div>
                          <label htmlFor="password" className="block text-sm font-medium mb-1">
                            Password
                          </label>
                          <div className="relative">
                            <input
                              id="password"
                              name="password"
                              type={showPassword ? "text" : "password"}
                              required
                              className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              placeholder="Enter your password"
                              disabled={isLoading}
                            />
                            <button
                              type="button"
                              className="absolute inset-y-0 right-0 flex items-center pr-3"
                              onClick={() => setShowPassword(!showPassword)}
                              tabIndex={-1}
                            >
                              {showPassword ? (
                                <EyeOff className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
                              ) : (
                                <Eye className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    </form>
                  </CardContent>
                  <CardFooter>
                    <Button type="submit" form="login-form" className="w-full" disabled={isLoading}>
                      {isLoading ? 'Logging in...' : 'Log In'}
                    </Button>
                  </CardFooter>
                </TabsContent>

                <TabsContent value="sso">
                  <CardContent>
                    <div className="space-y-4">
                      {authMethods.sso.providers.length > 0 && (
                        <>
                          <div className="space-y-2">
                            <p className="text-sm text-muted-foreground text-center">
                              Sign in with your organization account
                            </p>
                            {authMethods.sso.providers.map(provider => (
                              <Button
                                key={provider.id}
                                variant="outline"
                                className="w-full"
                                onClick={() => handleSSOLogin(provider.domain, provider.providerId)}
                                disabled={isLoading}
                              >
                                <Globe className="h-4 w-4 mr-2" />
                                Sign in with {provider.domain}
                              </Button>
                            ))}
                          </div>
                          
                          <div className="relative">
                            <div className="absolute inset-0 flex items-center">
                              <Separator />
                            </div>
                            <div className="relative flex justify-center text-xs uppercase">
                              <span className="bg-background px-2 text-muted-foreground">Or</span>
                            </div>
                          </div>
                        </>
                      )}
                      
                      <div>
                        <label htmlFor="sso-email" className="block text-sm font-medium mb-1">
                          Work Email
                        </label>
                        <input
                          id="sso-email"
                          type="email"
                          value={ssoEmail}
                          onChange={(e) => setSsoEmail(e.target.value)}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          placeholder="Enter your work email"
                          disabled={isLoading}
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          We'll redirect you to your organization's SSO provider
                        </p>
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button 
                      className="w-full" 
                      onClick={() => handleSSOLogin(undefined, undefined)}
                      disabled={isLoading || !ssoEmail}
                    >
                      {isLoading ? 'Redirecting...' : 'Continue with SSO'}
                    </Button>
                  </CardFooter>
                </TabsContent>
              </Tabs>
            ) : (
              // Single auth method - show email/password only
              <>
                <CardContent>
                  <form id="login-form" onSubmit={handleLogin}>
                    <div className="space-y-4">
                      <div>
                        <label htmlFor="email" className="block text-sm font-medium mb-1">
                          Email
                        </label>
                        <input
                          id="email"
                          name="email"
                          type="email"
                          required
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          placeholder="Enter your email"
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
                    </div>
                  </form>
                </CardContent>
                <CardFooter>
                  <Button type="submit" form="login-form" className="w-full" disabled={isLoading}>
                    {isLoading ? 'Logging in...' : 'Log In'}
                  </Button>
                </CardFooter>
              </>
            )}
          </>
        )}
        
        <div className="px-6 pb-6 text-center">
          <p className="text-sm text-muted-foreground">
            Don't have an account? Contact your administrator.
          </p>
        </div>
      </Card>
      <Toaster />
    </>
  );
}
