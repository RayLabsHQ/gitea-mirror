'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { authClient } from '@/lib/auth-client';
import { apiRequest, showErrorToast } from '@/lib/utils';
import { toast, Toaster } from 'sonner';
import { Shield, User, Mail, ChevronRight, AlertTriangle, Loader2 } from 'lucide-react';
import { isValidRedirectUri, parseRedirectUris } from '@/lib/utils/oauth-validation';

interface OAuthApplication {
  id: string;
  clientId: string;
  name: string;
  redirectURLs: string;
  type: string;
}

interface ConsentRequest {
  clientId: string;
  scope: string;
  state?: string;
  redirectUri?: string;
}

export default function ConsentPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [application, setApplication] = useState<OAuthApplication | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConsentDetails();
  }, []);

  const loadConsentDetails = async () => {
    try {
      const params = new URLSearchParams(window.location.search);
      const clientId = params.get('client_id');
      const scope = params.get('scope');
      const redirectUri = params.get('redirect_uri');

      if (!clientId) {
        setError('Invalid authorization request: missing client ID');
        return;
      }

      // Fetch application details
      const apps = await apiRequest<OAuthApplication[]>('/sso/applications');
      const app = apps.find(a => a.clientId === clientId);

      if (!app) {
        setError('Invalid authorization request: unknown application');
        return;
      }

      // Validate redirect URI if provided
      if (redirectUri) {
        const authorizedUris = parseRedirectUris(app.redirectURLs);
        
        if (!isValidRedirectUri(redirectUri, authorizedUris)) {
          setError('Invalid authorization request: unauthorized redirect URI');
          return;
        }
      }

      setApplication(app);

      // Parse requested scopes
      const requestedScopes = scope ? scope.split(' ').filter(s => s) : ['openid'];
      setScopes(requestedScopes);
      
      // By default, select all requested scopes
      setSelectedScopes(new Set(requestedScopes));
    } catch (error) {
      console.error('Failed to load consent details:', error);
      setError('Failed to load authorization details');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConsent = async (accept: boolean) => {
    setIsSubmitting(true);
    try {
      // The OAuth provider redirected here with the authorization request in
      // the query string (client_id, scope, code). Hand that back via
      // `oauth_query` so the provider can resume the flow. It validates the
      // redirect URI server-side and returns the URL to navigate to — either
      // with an authorization code (accept) or an error (deny).
      const oauthQuery = window.location.search.replace(/^\?/, '');
      const result = await authClient.oauth2.consent({
        accept,
        oauth_query: oauthQuery,
        scope: Array.from(selectedScopes).join(' '),
      });

      if (result.error) {
        throw new Error(result.error.message || 'Consent failed');
      }

      const redirectUri = (result.data as { redirect_uri?: string } | undefined)?.redirect_uri;
      if (redirectUri) {
        // The redirect URI is produced and validated server-side.
        window.location.href = redirectUri;
      } else if (!accept) {
        // No redirect target returned on denial — return to the app.
        window.location.href = '/';
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleScope = (scope: string) => {
    // openid scope is always required
    if (scope === 'openid') return;

    const newSelected = new Set(selectedScopes);
    if (newSelected.has(scope)) {
      newSelected.delete(scope);
    } else {
      newSelected.add(scope);
    }
    setSelectedScopes(newSelected);
  };

  const getScopeDescription = (scope: string): { name: string; description: string; icon: any } => {
    const scopeDescriptions: Record<string, { name: string; description: string; icon: any }> = {
      openid: {
        name: 'Basic Information',
        description: 'Your user ID (required)',
        icon: User,
      },
      profile: {
        name: 'Profile Information',
        description: 'Your name, username, and profile picture',
        icon: User,
      },
      email: {
        name: 'Email Address',
        description: 'Your email address and verification status',
        icon: Mail,
      },
    };

    return scopeDescriptions[scope] || {
      name: scope,
      description: `Access to ${scope} information`,
      icon: Shield,
    };
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle className="text-2xl">Authorization Error</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter>
            <Button 
              variant="outline" 
              className="w-full"
              onClick={() => window.history.back()}
            >
              Go Back
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Shield className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-2xl">Authorize {application?.name}</CardTitle>
            <CardDescription>
              This application is requesting access to your account
            </CardDescription>
          </CardHeader>
          
          <CardContent className="space-y-4">
            <div className="bg-muted p-4 rounded-lg">
              <p className="text-sm font-medium mb-2">Requested permissions:</p>
              <div className="space-y-3">
                {scopes.map(scope => {
                  const scopeInfo = getScopeDescription(scope);
                  const Icon = scopeInfo.icon;
                  const isRequired = scope === 'openid';
                  
                  return (
                    <div key={scope} className="flex items-start space-x-3">
                      <Checkbox
                        id={scope}
                        checked={selectedScopes.has(scope)}
                        onCheckedChange={() => toggleScope(scope)}
                        disabled={isRequired || isSubmitting}
                      />
                      <div className="flex-1">
                        <Label
                          htmlFor={scope}
                          className="flex items-center gap-2 font-medium cursor-pointer"
                        >
                          <Icon className="h-4 w-4" />
                          {scopeInfo.name}
                          {isRequired && (
                            <span className="text-xs text-muted-foreground">(required)</span>
                          )}
                        </Label>
                        <p className="text-xs text-muted-foreground mt-1">
                          {scopeInfo.description}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <Separator />

            <div className="text-sm text-muted-foreground">
              <p className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3" />
                You'll be redirected to {application?.type === 'web' ? 'the website' : 'the application'}
              </p>
              <p className="flex items-center gap-1 mt-1">
                <ChevronRight className="h-3 w-3" />
                You can revoke access at any time in your account settings
              </p>
            </div>
          </CardContent>

          <CardFooter className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => handleConsent(false)}
              disabled={isSubmitting}
            >
              Deny
            </Button>
            <Button
              className="flex-1"
              onClick={() => handleConsent(true)}
              disabled={isSubmitting || selectedScopes.size === 0}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Authorizing...
                </>
              ) : (
                'Authorize'
              )}
            </Button>
          </CardFooter>
        </Card>
      </div>
      <Toaster />
    </>
  );
}