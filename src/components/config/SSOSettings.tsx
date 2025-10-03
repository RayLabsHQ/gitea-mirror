import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { apiRequest, showErrorToast } from '@/lib/utils';
import { toast } from 'sonner';
import { Plus, Trash2, Loader2, AlertCircle, Shield, Edit2 } from 'lucide-react';
import { Skeleton } from '../ui/skeleton';
import { Badge } from '../ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { MultiSelect } from '@/components/ui/multi-select';
import { authClient } from '@/lib/auth-client';

function isTrustedIssuer(issuer: string, allowedHosts: string[]): boolean {
  try {
    const url = new URL(issuer);
    return allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false; // Return false if the URL is invalid
  }
}
interface SSOProvider {
  id: string;
  issuer: string;
  domain: string;
  providerId: string;
  organizationId?: string;
  oidcConfig?: {
    clientId: string;
    clientSecret: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksEndpoint?: string;
    userInfoEndpoint?: string;
    discoveryEndpoint?: string;
    scopes?: string[];
    pkce?: boolean;
  };
  samlConfig?: {
    entryPoint: string;
    cert: string;
    callbackUrl?: string;
    audience?: string;
    wantAssertionsSigned?: boolean;
    signatureAlgorithm?: string;
    digestAlgorithm?: string;
    identifierFormat?: string;
  };
  mapping?: {
    id: string;
    email: string;
    emailVerified?: string;
    name?: string;
    image?: string;
    firstName?: string;
    lastName?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export function SSOSettings() {
  const [providers, setProviders] = useState<SSOProvider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showProviderDialog, setShowProviderDialog] = useState(false);
  const [addingProvider, setAddingProvider] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [headerAuthEnabled, setHeaderAuthEnabled] = useState(false);
  const [editingProvider, setEditingProvider] = useState<SSOProvider | null>(null);

  // Form states for new provider
  const [providerType, setProviderType] = useState<'oidc' | 'saml'>('oidc');
  const [providerForm, setProviderForm] = useState({
    // Common fields
    issuer: '',
    domain: '',
    providerId: '',
    organizationId: '',
    // OIDC fields
    clientId: '',
    clientSecret: '',
    authorizationEndpoint: '',
    tokenEndpoint: '',
    jwksEndpoint: '',
    userInfoEndpoint: '',
    discoveryEndpoint: '',
    scopes: ['openid', 'email', 'profile'] as string[],
    pkce: true,
    // SAML fields
    entryPoint: '',
    cert: '',
    callbackUrl: '',
    audience: '',
    wantAssertionsSigned: true,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  });



  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [providersRes, headerAuthStatus] = await Promise.all([
        apiRequest<SSOProvider[] | { providers: SSOProvider[] }>('/sso/providers'),
        apiRequest<{ enabled: boolean }>('/auth/header-status').catch(() => ({ enabled: false }))
      ]);
      
      setProviders(Array.isArray(providersRes) ? providersRes : providersRes?.providers || []);
      setHeaderAuthEnabled(headerAuthStatus.enabled);
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsLoading(false);
    }
  };

  const discoverOIDC = async () => {
    if (!providerForm.issuer) {
      toast.error('Please enter an issuer URL');
      return;
    }

    setIsDiscovering(true);
    try {
      const discovered = await apiRequest<any>('/sso/discover', {
        method: 'POST',
        data: { issuer: providerForm.issuer },
      });

      setProviderForm(prev => ({
        ...prev,
        authorizationEndpoint: discovered.authorizationEndpoint || '',
        tokenEndpoint: discovered.tokenEndpoint || '',
        jwksEndpoint: discovered.jwksEndpoint || '',
        userInfoEndpoint: discovered.userInfoEndpoint || '',
        discoveryEndpoint: discovered.discoveryEndpoint || `${providerForm.issuer}/.well-known/openid-configuration`,
        domain: discovered.suggestedDomain || prev.domain,
      }));

      toast.success('OIDC configuration discovered successfully');
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsDiscovering(false);
    }
  };

  const createProvider = async () => {
    setAddingProvider(true);
    try {
      if (editingProvider) {
        // Delete and recreate to align with Better Auth docs
        try {
          await apiRequest(`/sso/providers?id=${editingProvider.id}`, { method: 'DELETE' });
        } catch (e) {
          // Continue even if local delete fails; registration will mirror latest
          console.warn('Failed to delete local provider before recreate', e);
        }

        // Recreate via Better Auth registration
        try {
          if (providerType === 'oidc') {
            await authClient.sso.register({
              providerId: providerForm.providerId,
              issuer: providerForm.issuer,
              domain: providerForm.domain,
              organizationId: providerForm.organizationId || undefined,
              oidcConfig: {
                clientId: providerForm.clientId || undefined,
                clientSecret: providerForm.clientSecret || undefined,
                authorizationEndpoint: providerForm.authorizationEndpoint || undefined,
                tokenEndpoint: providerForm.tokenEndpoint || undefined,
                jwksEndpoint: providerForm.jwksEndpoint || undefined,
                userInfoEndpoint: providerForm.userInfoEndpoint || undefined,
                discoveryEndpoint: providerForm.discoveryEndpoint || undefined,
                scopes: providerForm.scopes,
                pkce: providerForm.pkce,
              },
              mapping: {
                id: 'sub',
                email: 'email',
                emailVerified: 'email_verified',
                name: 'name',
                image: 'picture',
              },
            } as any);
          } else {
            await authClient.sso.register({
              providerId: providerForm.providerId,
              issuer: providerForm.issuer,
              domain: providerForm.domain,
              organizationId: providerForm.organizationId || undefined,
              samlConfig: {
                entryPoint: providerForm.entryPoint,
                cert: providerForm.cert,
                callbackUrl:
                  providerForm.callbackUrl ||
                  `${window.location.origin}/api/auth/sso/saml2/callback/${providerForm.providerId}`,
                audience: providerForm.audience || window.location.origin,
                wantAssertionsSigned: providerForm.wantAssertionsSigned,
                signatureAlgorithm: providerForm.signatureAlgorithm,
                digestAlgorithm: providerForm.digestAlgorithm,
                identifierFormat: providerForm.identifierFormat,
              },
              mapping: {
                id: 'nameID',
                email: 'email',
                name: 'displayName',
                firstName: 'givenName',
                lastName: 'surname',
              },
            } as any);
          }
          toast.success('SSO provider recreated');
        } catch (e: any) {
          console.error('Recreate failed', e);
          const msg = typeof e?.message === 'string' ? e.message : String(e);
          // Common case: providerId already exists in Better Auth
          if (msg.toLowerCase().includes('already exists')) {
            toast.error('Provider ID already exists in auth server. Choose a new Provider ID and try again.');
          } else {
            showErrorToast(e, toast);
          }
        }

        // Refresh providers from our API after registration mirrors into DB
        const refreshed = await apiRequest<SSOProvider[] | { providers: SSOProvider[] }>(
          '/sso/providers'
        );
        setProviders(Array.isArray(refreshed) ? refreshed : refreshed?.providers || []);
      } else {
        // Create new provider - follow Better Auth docs using the SSO client
        if (providerType === 'oidc') {
          await authClient.sso.register({
            providerId: providerForm.providerId,
            issuer: providerForm.issuer,
            domain: providerForm.domain,
            organizationId: providerForm.organizationId || undefined,
            oidcConfig: {
              clientId: providerForm.clientId || undefined,
              clientSecret: providerForm.clientSecret || undefined,
              authorizationEndpoint: providerForm.authorizationEndpoint || undefined,
              tokenEndpoint: providerForm.tokenEndpoint || undefined,
              jwksEndpoint: providerForm.jwksEndpoint || undefined,
              userInfoEndpoint: providerForm.userInfoEndpoint || undefined,
              discoveryEndpoint: providerForm.discoveryEndpoint || undefined,
              scopes: providerForm.scopes,
              pkce: providerForm.pkce,
            },
            mapping: {
              id: 'sub',
              email: 'email',
              emailVerified: 'email_verified',
              name: 'name',
              image: 'picture',
            },
          } as any);
        } else {
          await authClient.sso.register({
            providerId: providerForm.providerId,
            issuer: providerForm.issuer,
            domain: providerForm.domain,
            organizationId: providerForm.organizationId || undefined,
            samlConfig: {
              entryPoint: providerForm.entryPoint,
              cert: providerForm.cert,
              callbackUrl:
                providerForm.callbackUrl ||
                `${window.location.origin}/api/auth/sso/saml2/callback/${providerForm.providerId}`,
              audience: providerForm.audience || window.location.origin,
              wantAssertionsSigned: providerForm.wantAssertionsSigned,
              signatureAlgorithm: providerForm.signatureAlgorithm,
              digestAlgorithm: providerForm.digestAlgorithm,
              identifierFormat: providerForm.identifierFormat,
            },
            mapping: {
              id: 'nameID',
              email: 'email',
              name: 'displayName',
              firstName: 'givenName',
              lastName: 'surname',
            },
          } as any);
        }

        // Refresh providers from our API after registration mirrors into DB
        const refreshed = await apiRequest<SSOProvider[] | { providers: SSOProvider[] }>(
          '/sso/providers'
        );
        setProviders(Array.isArray(refreshed) ? refreshed : refreshed?.providers || []);
        toast.success('SSO provider created successfully');
      }

      setShowProviderDialog(false);
      setEditingProvider(null);
      setProviderForm({
        issuer: '',
        domain: '',
        providerId: '',
        organizationId: '',
        clientId: '',
        clientSecret: '',
        authorizationEndpoint: '',
        tokenEndpoint: '',
        jwksEndpoint: '',
        userInfoEndpoint: '',
        discoveryEndpoint: '',
        scopes: ['openid', 'email', 'profile'] as string[],
        pkce: true,
        entryPoint: '',
        cert: '',
        callbackUrl: '',
        audience: '',
        wantAssertionsSigned: true,
        signatureAlgorithm: 'sha256',
        digestAlgorithm: 'sha256',
        identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      });
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setAddingProvider(false);
    }
  };

  const startEditProvider = (provider: SSOProvider) => {
    setEditingProvider(provider);
    setProviderType(provider.samlConfig ? 'saml' : 'oidc');
    
    if (provider.oidcConfig) {
      setProviderForm({
        ...providerForm,
        providerId: provider.providerId,
        issuer: provider.issuer,
        domain: provider.domain,
        organizationId: provider.organizationId || '',
        clientId: provider.oidcConfig.clientId || '',
        clientSecret: provider.oidcConfig.clientSecret || '',
        authorizationEndpoint: provider.oidcConfig.authorizationEndpoint || '',
        tokenEndpoint: provider.oidcConfig.tokenEndpoint || '',
        jwksEndpoint: provider.oidcConfig.jwksEndpoint || '',
        userInfoEndpoint: provider.oidcConfig.userInfoEndpoint || '',
        discoveryEndpoint: provider.oidcConfig.discoveryEndpoint || '',
        scopes: provider.oidcConfig.scopes || ['openid', 'email', 'profile'],
        pkce: provider.oidcConfig.pkce !== false,
      });
    }
    
    setShowProviderDialog(true);
  };

  const deleteProvider = async (id: string) => {
    try {
      await apiRequest(`/sso/providers?id=${id}`, { method: 'DELETE' });
      setProviders(providers.filter(p => p.id !== id));
      toast.success('Provider deleted successfully');
    } catch (error) {
      showErrorToast(error, toast);
    }
  };



  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with status indicators */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Authentication & SSO</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure how users authenticate with your application
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${providers.length > 0 ? 'bg-green-500' : 'bg-muted'}`} />
          <span className="text-sm text-muted-foreground">
            {providers.length} Provider{providers.length !== 1 ? 's' : ''} configured
          </span>
        </div>
      </div>

      {/* Authentication Methods Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Active Authentication Methods</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {/* Email & Password - Always enabled */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span className="text-sm font-medium">Email & Password</span>
                <Badge variant="secondary" className="text-xs">Default</Badge>
              </div>
              <span className="text-xs text-muted-foreground">Always enabled</span>
            </div>
            
            {/* Header Authentication Status */}
            {headerAuthEnabled && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                  <span className="text-sm font-medium">Header Authentication</span>
                  <Badge variant="secondary" className="text-xs">Auto-login</Badge>
                </div>
                <span className="text-xs text-muted-foreground">Via reverse proxy</span>
              </div>
            )}
            
            {/* SSO Providers Status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full ${providers.length > 0 ? 'bg-green-500' : 'bg-muted'}`} />
                <span className="text-sm font-medium">SSO/OIDC Providers</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {providers.length > 0 ? `${providers.length} provider${providers.length !== 1 ? 's' : ''} configured` : 'Not configured'}
              </span>
            </div>
          </div>
          
          {/* Header Auth Info */}
          {headerAuthEnabled && (
            <Alert className="mt-4">
              <Shield className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Header authentication is enabled. Users authenticated by your reverse proxy will be automatically logged in.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* SSO Providers */}
      <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg font-semibold">External Identity Providers</CardTitle>
                  <CardDescription className="text-sm">
                    Connect external OIDC/OAuth providers (Google, Azure AD, etc.) to allow users to sign in with their existing accounts
                  </CardDescription>
                </div>
                <Dialog open={showProviderDialog} onOpenChange={setShowProviderDialog}>
                  <DialogTrigger asChild>
                    <Button>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Provider
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-2xl max-h-[90vh] md:max-h-[85vh] lg:max-h-[90vh] overflow-hidden flex flex-col">
                    <DialogHeader className="flex-shrink-0">
                      <DialogTitle>{editingProvider ? 'Edit SSO Provider' : 'Add SSO Provider'}</DialogTitle>
                      <DialogDescription>
                        {editingProvider 
                          ? 'Update the configuration for this identity provider'
                          : 'Configure an external identity provider for user authentication'}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="flex-1 overflow-y-auto px-1 -mx-1">
                      <Tabs value={providerType} onValueChange={(value) => setProviderType(value as 'oidc' | 'saml')}>
                        <TabsList className="grid w-full grid-cols-2 sticky top-0 z-10 bg-background">
                          <TabsTrigger value="oidc">OIDC / OAuth2</TabsTrigger>
                          <TabsTrigger value="saml">SAML 2.0</TabsTrigger>
                        </TabsList>
                        
                        {/* Common Fields */}
                        <div className="space-y-4 mt-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="providerId">Provider ID</Label>
                            <Input
                              id="providerId"
                              value={providerForm.providerId}
                              onChange={e => setProviderForm(prev => ({ ...prev, providerId: e.target.value }))}
                              placeholder="google-sso"
                              disabled={!!editingProvider}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="domain">Email Domain</Label>
                            <Input
                              id="domain"
                              value={providerForm.domain}
                              onChange={e => setProviderForm(prev => ({ ...prev, domain: e.target.value }))}
                              placeholder="example.com"
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="issuer">Issuer URL</Label>
                          <div className="flex gap-2">
                            <Input
                              id="issuer"
                              value={providerForm.issuer}
                              onChange={e => setProviderForm(prev => ({ ...prev, issuer: e.target.value }))}
                              placeholder={providerType === 'oidc' ? "https://accounts.google.com" : "https://idp.example.com"}
                            />
                            {providerType === 'oidc' && (
                              <Button
                                variant="outline"
                                onClick={discoverOIDC}
                                disabled={isDiscovering}
                              >
                                {isDiscovering ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Discover'}
                              </Button>
                            )}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="organizationId">Organization ID (Optional)</Label>
                          <Input
                            id="organizationId"
                            value={providerForm.organizationId}
                            onChange={e => setProviderForm(prev => ({ ...prev, organizationId: e.target.value }))}
                            placeholder="org_123"
                          />
                          <p className="text-xs text-muted-foreground">Link this provider to an organization for automatic user provisioning</p>
                        </div>
                      </div>

                      <TabsContent value="oidc" className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="clientId">Client ID</Label>
                            <Input
                              id="clientId"
                              value={providerForm.clientId}
                              onChange={e => setProviderForm(prev => ({ ...prev, clientId: e.target.value }))}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="clientSecret">Client Secret</Label>
                            <Input
                              id="clientSecret"
                              type="password"
                              value={providerForm.clientSecret}
                              onChange={e => setProviderForm(prev => ({ ...prev, clientSecret: e.target.value }))}
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="authEndpoint">Authorization Endpoint</Label>
                          <Input
                            id="authEndpoint"
                            value={providerForm.authorizationEndpoint}
                            onChange={e => setProviderForm(prev => ({ ...prev, authorizationEndpoint: e.target.value }))}
                            placeholder="https://accounts.google.com/o/oauth2/auth"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="tokenEndpoint">Token Endpoint</Label>
                          <Input
                            id="tokenEndpoint"
                            value={providerForm.tokenEndpoint}
                            onChange={e => setProviderForm(prev => ({ ...prev, tokenEndpoint: e.target.value }))}
                            placeholder="https://oauth2.googleapis.com/token"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="scopes">OAuth Scopes</Label>
                          <MultiSelect
                            options={[
                              { label: "OpenID", value: "openid" },
                              { label: "Email", value: "email" },
                              { label: "Profile", value: "profile" },
                              { label: "Offline Access", value: "offline_access" },
                            ]}
                            selected={providerForm.scopes}
                            onChange={(scopes) => setProviderForm(prev => ({ ...prev, scopes }))}
                            placeholder="Select scopes..."
                          />
                          <p className="text-xs text-muted-foreground">
                            Select the OAuth scopes to request from the provider
                          </p>
                        </div>

                        <div className="flex items-center space-x-2">
                          <Switch
                            id="pkce"
                            checked={providerForm.pkce}
                            onCheckedChange={(checked) => setProviderForm(prev => ({ ...prev, pkce: checked }))}
                          />
                          <Label htmlFor="pkce">Enable PKCE</Label>
                        </div>

                        <Alert>
                          <AlertCircle className="h-4 w-4" />
                          <AlertDescription>
                            <div className="space-y-2">
                              <p>Redirect URL: {window.location.origin}/api/auth/sso/callback/{providerForm.providerId || '{provider-id}'}</p>
                              {isTrustedIssuer(providerForm.issuer, ['google.com']) && (
                                <p className="text-xs text-muted-foreground">
                                  Note: Google doesn't support the "offline_access" scope. Make sure to exclude it from the selected scopes.
                                </p>
                              )}
                            </div>
                          </AlertDescription>
                        </Alert>
                      </TabsContent>

                      <TabsContent value="saml" className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="entryPoint">SAML Entry Point</Label>
                          <Input
                            id="entryPoint"
                            value={providerForm.entryPoint}
                            onChange={e => setProviderForm(prev => ({ ...prev, entryPoint: e.target.value }))}
                            placeholder="https://idp.example.com/sso"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="cert">X.509 Certificate</Label>
                          <Textarea
                            id="cert"
                            value={providerForm.cert}
                            onChange={e => setProviderForm(prev => ({ ...prev, cert: e.target.value }))}
                            placeholder="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
                            rows={6}
                          />
                        </div>

                        <div className="flex items-center space-x-2">
                          <Switch
                            id="wantAssertionsSigned"
                            checked={providerForm.wantAssertionsSigned}
                            onCheckedChange={(checked) => setProviderForm(prev => ({ ...prev, wantAssertionsSigned: checked }))}
                          />
                          <Label htmlFor="wantAssertionsSigned">Require Signed Assertions</Label>
                        </div>

                        <Alert>
                          <AlertCircle className="h-4 w-4" />
                          <AlertDescription>
                            <div className="space-y-1">
                              <p>Callback URL: {window.location.origin}/api/auth/sso/saml2/callback/{providerForm.providerId || '{provider-id}'}</p>
                              <p>SP Metadata: {window.location.origin}/api/auth/sso/saml2/sp/metadata?providerId={providerForm.providerId || '{provider-id}'}</p>
                            </div>
                          </AlertDescription>
                        </Alert>
                      </TabsContent>
                    </Tabs>
                    </div>
                    <DialogFooter className="flex-shrink-0 pt-4 border-t">
                      <Button 
                        variant="outline" 
                        onClick={() => {
                          setShowProviderDialog(false);
                          setEditingProvider(null);
                          // Reset form
                          setProviderForm({
                            issuer: '',
                            domain: '',
                            providerId: '',
                            organizationId: '',
                            clientId: '',
                            clientSecret: '',
                            authorizationEndpoint: '',
                            tokenEndpoint: '',
                            jwksEndpoint: '',
                            userInfoEndpoint: '',
                            discoveryEndpoint: '',
                            scopes: ['openid', 'email', 'profile'] as string[],
                            pkce: true,
                            entryPoint: '',
                            cert: '',
                            callbackUrl: '',
                            audience: '',
                            wantAssertionsSigned: true,
                            signatureAlgorithm: 'sha256',
                            digestAlgorithm: 'sha256',
                            identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
                          });
                        }}
                      >
                        Cancel
                      </Button>
                      <Button onClick={createProvider} disabled={addingProvider}>
                        {addingProvider ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {editingProvider ? 'Updating...' : 'Creating...'}
                          </>
                        ) : (
                          editingProvider ? 'Update Provider' : 'Create Provider'
                        )}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {providers.length === 0 ? (
                <div className="text-center py-12">
                  <div className="mx-auto h-12 w-12 text-muted-foreground/50">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                    </svg>
                  </div>
                  <h3 className="mt-4 text-lg font-medium">No SSO providers configured</h3>
                  <p className="mt-2 text-sm text-muted-foreground max-w-sm mx-auto">
                    Enable Single Sign-On by adding an external identity provider like Google, Azure AD, or any OIDC-compliant service.
                  </p>
                  <div className="mt-6">
                    <Button onClick={() => setShowProviderDialog(true)}>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Your First Provider
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {providers.map(provider => (
                    <div key={provider.id} className="border rounded-lg p-4 hover:bg-muted/50 transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <h4 className="font-semibold text-sm">{provider.providerId}</h4>
                            <Badge variant="outline" className="text-xs">
                              {provider.samlConfig ? 'SAML' : 'OIDC'}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mb-3">{provider.domain}</p>
                          
                          <div className="space-y-2">
                            <div className="flex items-start gap-2 text-sm">
                              <span className="text-muted-foreground min-w-[80px]">Issuer:</span>
                              <span className="text-muted-foreground break-all">{provider.issuer}</span>
                            </div>
                            
                            {provider.oidcConfig && (
                              <>
                                <div className="flex items-start gap-2 text-sm">
                                  <span className="text-muted-foreground min-w-[80px]">Client ID:</span>
                                  <span className="font-mono text-xs text-muted-foreground break-all">{provider.oidcConfig.clientId}</span>
                                </div>
                                
                                {provider.oidcConfig.scopes && provider.oidcConfig.scopes.length > 0 && (
                                  <div className="flex items-start gap-2 text-sm">
                                    <span className="text-muted-foreground min-w-[80px]">Scopes:</span>
                                    <div className="flex flex-wrap gap-1">
                                      {provider.oidcConfig.scopes.map(scope => (
                                        <Badge key={scope} variant="secondary" className="text-xs">
                                          {scope}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </>
                            )}
                            
                            {provider.samlConfig && (
                              <div className="flex items-start gap-2 text-sm">
                                <span className="text-muted-foreground min-w-[80px]">Entry Point:</span>
                                <span className="text-muted-foreground break-all">{provider.samlConfig.entryPoint}</span>
                              </div>
                            )}
                            
                            {provider.organizationId && (
                              <div className="flex items-start gap-2 text-sm">
                                <span className="text-muted-foreground min-w-[80px]">Organization:</span>
                                <span className="text-muted-foreground">{provider.organizationId}</span>
                              </div>
                            )}
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => startEditProvider(provider)}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => deleteProvider(provider.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
      </Card>
    </div>
  );
}
