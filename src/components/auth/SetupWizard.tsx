import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Shield, Key, Server, AlertCircle, Check } from "lucide-react";

interface SetupWizardProps {
  onComplete?: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<"method" | "config" | "complete">("method");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  
  // Auth configuration state
  const [authMethod, setAuthMethod] = useState<"local" | "oidc" | "forward">("local");
  const [allowLocalFallback, setAllowLocalFallback] = useState(false);
  
  // OIDC configuration
  const [oidcConfig, setOidcConfig] = useState({
    issuerUrl: "",
    clientId: "",
    clientSecret: "",
    autoCreateUsers: true,
  });
  
  // Forward auth configuration
  const [forwardAuthConfig, setForwardAuthConfig] = useState({
    userHeader: "X-Remote-User",
    emailHeader: "X-Remote-Email",
    nameHeader: "X-Remote-Name",
    trustedProxies: "",
    autoCreateUsers: true,
  });
  
  const handleMethodSelect = () => {
    if (authMethod === "local") {
      // Skip configuration step for local auth
      handleSave();
    } else {
      setStep("config");
    }
  };
  
  const handleSave = async () => {
    setLoading(true);
    setError("");
    
    try {
      const config: any = {
        method: authMethod,
        allowLocalFallback: authMethod !== "local" ? allowLocalFallback : false,
      };
      
      if (authMethod === "oidc") {
        // Validate OIDC config
        if (!oidcConfig.issuerUrl || !oidcConfig.clientId || !oidcConfig.clientSecret) {
          throw new Error("Please fill in all required OIDC fields");
        }
        
        config.oidc = {
          issuerUrl: oidcConfig.issuerUrl.trim(),
          clientId: oidcConfig.clientId.trim(),
          clientSecret: oidcConfig.clientSecret.trim(),
          autoCreateUsers: oidcConfig.autoCreateUsers,
        };
      } else if (authMethod === "forward") {
        // Validate forward auth config
        const proxies = forwardAuthConfig.trustedProxies
          .split(",")
          .map(ip => ip.trim())
          .filter(ip => ip);
          
        if (proxies.length === 0) {
          throw new Error("Please specify at least one trusted proxy IP");
        }
        
        config.forwardAuth = {
          userHeader: forwardAuthConfig.userHeader.trim(),
          emailHeader: forwardAuthConfig.emailHeader.trim(),
          nameHeader: forwardAuthConfig.nameHeader.trim() || undefined,
          trustedProxies: proxies,
          autoCreateUsers: forwardAuthConfig.autoCreateUsers,
        };
      }
      
      // Save configuration
      const response = await fetch("/api/auth/setup/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(config),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || "Failed to save configuration");
      }
      
      setStep("complete");
      
      // Redirect to signup after a short delay
      setTimeout(() => {
        if (onComplete) {
          onComplete();
        } else {
          window.location.href = "/signup";
        }
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-2xl">Welcome to Gitea Mirror</CardTitle>
          <CardDescription>
            Let's set up authentication for your instance
          </CardDescription>
        </CardHeader>
        
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-6">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          
          {step === "method" && (
            <div className="space-y-6">
              <div className="space-y-4">
                <Label>Choose your authentication method</Label>
                <RadioGroup value={authMethod} onValueChange={(v) => setAuthMethod(v as any)}>
                  <div className="space-y-3">
                    <label className="flex items-start space-x-3 cursor-pointer p-4 rounded-lg border hover:bg-accent">
                      <RadioGroupItem value="local" className="mt-1" />
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <Key className="h-4 w-4" />
                          <span className="font-medium">Local Authentication</span>
                          <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">Recommended</span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Simple username and password authentication. Perfect for personal use or small teams.
                          No additional setup required.
                        </p>
                      </div>
                    </label>
                    
                    <label className="flex items-start space-x-3 cursor-pointer p-4 rounded-lg border hover:bg-accent">
                      <RadioGroupItem value="oidc" className="mt-1" />
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <Shield className="h-4 w-4" />
                          <span className="font-medium">SSO / OIDC</span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Connect to your existing identity provider (Authentik, Keycloak, Google, Auth0, etc).
                          Great for organizations with existing SSO.
                        </p>
                      </div>
                    </label>
                    
                    <label className="flex items-start space-x-3 cursor-pointer p-4 rounded-lg border hover:bg-accent">
                      <RadioGroupItem value="forward" className="mt-1" />
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <Server className="h-4 w-4" />
                          <span className="font-medium">Forward Authentication</span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Use authentication from your reverse proxy (Authentik, Authelia, etc).
                          Requires proxy configuration.
                        </p>
                      </div>
                    </label>
                  </div>
                </RadioGroup>
              </div>
              
              {authMethod !== "local" && (
                <div className="flex items-center space-x-3 p-4 bg-muted rounded-lg">
                  <Switch
                    checked={allowLocalFallback}
                    onCheckedChange={setAllowLocalFallback}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="fallback">Allow local authentication as fallback</Label>
                    <p className="text-sm text-muted-foreground">
                      Enable this to allow local login when external authentication is unavailable
                    </p>
                  </div>
                </div>
              )}
              
              <Button
                className="w-full"
                size="lg"
                onClick={handleMethodSelect}
              >
                Continue
              </Button>
            </div>
          )}
          
          {step === "config" && authMethod === "oidc" && (
            <div className="space-y-6">
              <div className="space-y-4">
                <div>
                  <Label htmlFor="issuerUrl">OIDC Issuer URL</Label>
                  <Input
                    id="issuerUrl"
                    type="url"
                    placeholder="https://auth.example.com/application/o/gitea-mirror/"
                    value={oidcConfig.issuerUrl}
                    onChange={(e) => setOidcConfig({ ...oidcConfig, issuerUrl: e.target.value })}
                    className="mt-1"
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    The base URL of your OIDC provider
                  </p>
                </div>
                
                <div>
                  <Label htmlFor="clientId">Client ID</Label>
                  <Input
                    id="clientId"
                    placeholder="gitea-mirror"
                    value={oidcConfig.clientId}
                    onChange={(e) => setOidcConfig({ ...oidcConfig, clientId: e.target.value })}
                    className="mt-1"
                  />
                </div>
                
                <div>
                  <Label htmlFor="clientSecret">Client Secret</Label>
                  <Input
                    id="clientSecret"
                    type="password"
                    placeholder="Your client secret"
                    value={oidcConfig.clientSecret}
                    onChange={(e) => setOidcConfig({ ...oidcConfig, clientSecret: e.target.value })}
                    className="mt-1"
                  />
                </div>
                
                <div className="flex items-center space-x-3">
                  <Switch
                    checked={oidcConfig.autoCreateUsers}
                    onCheckedChange={(v) => setOidcConfig({ ...oidcConfig, autoCreateUsers: v })}
                  />
                  <div>
                    <Label>Auto-create users on first login</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically create user accounts when they log in via SSO
                    </p>
                  </div>
                </div>
              </div>
              
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Make sure to add <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    {window.location.origin}/api/auth/oidc/callback
                  </code> as a redirect URI in your OIDC provider
                </AlertDescription>
              </Alert>
              
              <div className="flex space-x-3">
                <Button
                  variant="outline"
                  onClick={() => setStep("method")}
                  disabled={loading}
                >
                  Back
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleSave}
                  disabled={loading}
                >
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Configuration
                </Button>
              </div>
            </div>
          )}
          
          {step === "config" && authMethod === "forward" && (
            <div className="space-y-6">
              <div className="space-y-4">
                <div>
                  <Label htmlFor="userHeader">Username Header</Label>
                  <Input
                    id="userHeader"
                    placeholder="X-Remote-User"
                    value={forwardAuthConfig.userHeader}
                    onChange={(e) => setForwardAuthConfig({ ...forwardAuthConfig, userHeader: e.target.value })}
                    className="mt-1"
                  />
                </div>
                
                <div>
                  <Label htmlFor="emailHeader">Email Header</Label>
                  <Input
                    id="emailHeader"
                    placeholder="X-Remote-Email"
                    value={forwardAuthConfig.emailHeader}
                    onChange={(e) => setForwardAuthConfig({ ...forwardAuthConfig, emailHeader: e.target.value })}
                    className="mt-1"
                  />
                </div>
                
                <div>
                  <Label htmlFor="nameHeader">Display Name Header (optional)</Label>
                  <Input
                    id="nameHeader"
                    placeholder="X-Remote-Name"
                    value={forwardAuthConfig.nameHeader}
                    onChange={(e) => setForwardAuthConfig({ ...forwardAuthConfig, nameHeader: e.target.value })}
                    className="mt-1"
                  />
                </div>
                
                <div>
                  <Label htmlFor="trustedProxies">Trusted Proxy IPs</Label>
                  <Input
                    id="trustedProxies"
                    placeholder="10.0.0.1, 10.0.0.2, 192.168.0.0/24"
                    value={forwardAuthConfig.trustedProxies}
                    onChange={(e) => setForwardAuthConfig({ ...forwardAuthConfig, trustedProxies: e.target.value })}
                    className="mt-1"
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    Comma-separated list of IPs or CIDR ranges that are allowed to set auth headers
                  </p>
                </div>
                
                <div className="flex items-center space-x-3">
                  <Switch
                    checked={forwardAuthConfig.autoCreateUsers}
                    onCheckedChange={(v) => setForwardAuthConfig({ ...forwardAuthConfig, autoCreateUsers: v })}
                  />
                  <div>
                    <Label>Auto-create users from headers</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically create user accounts from proxy headers
                    </p>
                  </div>
                </div>
              </div>
              
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Make sure your reverse proxy is configured to pass authentication headers
                  and that only trusted proxies can access this application.
                </AlertDescription>
              </Alert>
              
              <div className="flex space-x-3">
                <Button
                  variant="outline"
                  onClick={() => setStep("method")}
                  disabled={loading}
                >
                  Back
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleSave}
                  disabled={loading}
                >
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Configuration
                </Button>
              </div>
            </div>
          )}
          
          {step === "complete" && (
            <div className="text-center space-y-6 py-8">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 dark:bg-green-900/20 rounded-full">
                <Check className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              
              <div className="space-y-2">
                <h3 className="text-lg font-semibold">Setup Complete!</h3>
                <p className="text-muted-foreground">
                  Authentication has been configured. Redirecting to create your admin account...
                </p>
              </div>
              
              <div className="flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}