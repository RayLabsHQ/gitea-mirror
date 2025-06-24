import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Loader2, Shield, Key, Server, AlertCircle, Edit2, Save, X } from "lucide-react";

interface AuthConfig {
  method: "local" | "oidc" | "forward";
  allowLocalFallback: boolean;
  isConfigured: boolean;
  forwardAuth?: {
    userHeader: string;
    emailHeader: string;
    nameHeader?: string;
    trustedProxies: string[];
    autoCreateUsers: boolean;
  };
  oidc?: {
    issuerUrl: string;
    clientId: string;
    redirectUri?: string;
    scopes: string[];
    autoCreateUsers: boolean;
    usernameClaim: string;
    emailClaim: string;
    nameClaim: string;
  };
}

export function AuthSettings() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  
  // Edit state
  const [editConfig, setEditConfig] = useState<any>({});
  
  useEffect(() => {
    fetchConfig();
  }, []);
  
  const fetchConfig = async () => {
    try {
      const response = await fetch("/api/auth/config");
      const data = await response.json();
      
      if (data.success) {
        setConfig(data.config);
        setEditConfig(data.config);
      } else {
        setError("Failed to load authentication configuration");
      }
    } catch (err) {
      setError("Error loading configuration");
    } finally {
      setLoading(false);
    }
  };
  
  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    
    try {
      // Validate configuration
      if (editConfig.method === "oidc") {
        if (!editConfig.oidc?.issuerUrl || !editConfig.oidc?.clientId) {
          throw new Error("OIDC configuration is incomplete");
        }
      } else if (editConfig.method === "forward") {
        if (!editConfig.forwardAuth?.trustedProxies?.length) {
          throw new Error("Forward auth requires at least one trusted proxy");
        }
      }
      
      // Save configuration via API
      const response = await fetch("/api/auth/setup/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(editConfig),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || "Failed to save configuration");
      }
      
      setSuccess("Authentication settings updated successfully");
      setConfig(editConfig);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };
  
  const getMethodIcon = (method: string) => {
    switch (method) {
      case "local":
        return <Key className="h-4 w-4" />;
      case "oidc":
        return <Shield className="h-4 w-4" />;
      case "forward":
        return <Server className="h-4 w-4" />;
      default:
        return null;
    }
  };
  
  const getMethodLabel = (method: string) => {
    switch (method) {
      case "local":
        return "Local Authentication";
      case "oidc":
        return "SSO / OIDC";
      case "forward":
        return "Forward Authentication";
      default:
        return method;
    }
  };
  
  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }
  
  if (!config) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>Failed to load authentication configuration</AlertDescription>
      </Alert>
    );
  }
  
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Authentication Settings</CardTitle>
            <CardDescription>
              Configure how users authenticate with your Gitea Mirror instance
            </CardDescription>
          </div>
          {!editing && (
            <Button
              onClick={() => setEditing(true)}
              variant="outline"
              size="sm"
            >
              <Edit2 className="h-4 w-4 mr-2" />
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        
        {success && (
          <Alert>
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}
        
        {/* Current Configuration Display */}
        {!editing && (
          <div className="space-y-4">
            <div className="flex items-center space-x-3">
              <div className="flex items-center space-x-2">
                {getMethodIcon(config.method)}
                <span className="font-medium">{getMethodLabel(config.method)}</span>
              </div>
              {config.isConfigured ? (
                <Badge variant="default">Configured</Badge>
              ) : (
                <Badge variant="secondary">Not Configured</Badge>
              )}
            </div>
            
            {config.allowLocalFallback && config.method !== "local" && (
              <div className="text-sm text-muted-foreground">
                Local authentication is enabled as a fallback
              </div>
            )}
            
            {config.method === "oidc" && config.oidc && (
              <div className="space-y-2 pl-6">
                <div className="text-sm">
                  <span className="text-muted-foreground">Issuer URL:</span>
                  <span className="ml-2 font-mono text-xs">{config.oidc.issuerUrl}</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Client ID:</span>
                  <span className="ml-2 font-mono text-xs">{config.oidc.clientId}</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Auto-create users:</span>
                  <span className="ml-2">{config.oidc.autoCreateUsers ? "Yes" : "No"}</span>
                </div>
              </div>
            )}
            
            {config.method === "forward" && config.forwardAuth && (
              <div className="space-y-2 pl-6">
                <div className="text-sm">
                  <span className="text-muted-foreground">User header:</span>
                  <span className="ml-2 font-mono text-xs">{config.forwardAuth.userHeader}</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Trusted proxies:</span>
                  <span className="ml-2 font-mono text-xs">
                    {config.forwardAuth.trustedProxies.join(", ")}
                  </span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Auto-create users:</span>
                  <span className="ml-2">{config.forwardAuth.autoCreateUsers ? "Yes" : "No"}</span>
                </div>
              </div>
            )}
          </div>
        )}
        
        {/* Edit Form */}
        {editing && (
          <div className="space-y-6">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Changing authentication methods may affect existing users. Make sure you understand
                the implications before saving changes.
              </AlertDescription>
            </Alert>
            
            <div className="space-y-4">
              <div>
                <Label>Authentication Method</Label>
                <p className="text-sm text-muted-foreground mb-2">
                  Changing this will affect how all users log in
                </p>
                <select
                  className="w-full p-2 border rounded-md"
                  value={editConfig.method}
                  onChange={(e) => setEditConfig({ ...editConfig, method: e.target.value })}
                >
                  <option value="local">Local Authentication</option>
                  <option value="oidc">SSO / OIDC</option>
                  <option value="forward">Forward Authentication</option>
                </select>
              </div>
              
              {editConfig.method !== "local" && (
                <div className="flex items-center space-x-3">
                  <Switch
                    checked={editConfig.allowLocalFallback}
                    onCheckedChange={(v) => setEditConfig({ ...editConfig, allowLocalFallback: v })}
                  />
                  <div>
                    <Label>Allow local authentication as fallback</Label>
                    <p className="text-sm text-muted-foreground">
                      Users can still use username/password if external auth fails
                    </p>
                  </div>
                </div>
              )}
              
              {editConfig.method === "oidc" && (
                <div className="space-y-4 border-l-2 pl-4">
                  <div>
                    <Label htmlFor="issuerUrl">OIDC Issuer URL</Label>
                    <Input
                      id="issuerUrl"
                      type="url"
                      value={editConfig.oidc?.issuerUrl || ""}
                      onChange={(e) => setEditConfig({
                        ...editConfig,
                        oidc: { ...editConfig.oidc, issuerUrl: e.target.value }
                      })}
                    />
                  </div>
                  
                  <div>
                    <Label htmlFor="clientId">Client ID</Label>
                    <Input
                      id="clientId"
                      value={editConfig.oidc?.clientId || ""}
                      onChange={(e) => setEditConfig({
                        ...editConfig,
                        oidc: { ...editConfig.oidc, clientId: e.target.value }
                      })}
                    />
                  </div>
                  
                  <div className="flex items-center space-x-3">
                    <Switch
                      checked={editConfig.oidc?.autoCreateUsers ?? true}
                      onCheckedChange={(v) => setEditConfig({
                        ...editConfig,
                        oidc: { ...editConfig.oidc, autoCreateUsers: v }
                      })}
                    />
                    <Label>Auto-create users on first login</Label>
                  </div>
                </div>
              )}
              
              {editConfig.method === "forward" && (
                <div className="space-y-4 border-l-2 pl-4">
                  <div>
                    <Label htmlFor="userHeader">Username Header</Label>
                    <Input
                      id="userHeader"
                      value={editConfig.forwardAuth?.userHeader || "X-Remote-User"}
                      onChange={(e) => setEditConfig({
                        ...editConfig,
                        forwardAuth: { ...editConfig.forwardAuth, userHeader: e.target.value }
                      })}
                    />
                  </div>
                  
                  <div>
                    <Label htmlFor="trustedProxies">Trusted Proxy IPs</Label>
                    <Input
                      id="trustedProxies"
                      placeholder="10.0.0.1, 192.168.1.0/24"
                      value={editConfig.forwardAuth?.trustedProxies?.join(", ") || ""}
                      onChange={(e) => setEditConfig({
                        ...editConfig,
                        forwardAuth: {
                          ...editConfig.forwardAuth,
                          trustedProxies: e.target.value.split(",").map(ip => ip.trim()).filter(Boolean)
                        }
                      })}
                    />
                    <p className="text-sm text-muted-foreground mt-1">
                      Comma-separated list of IPs or CIDR ranges
                    </p>
                  </div>
                  
                  <div className="flex items-center space-x-3">
                    <Switch
                      checked={editConfig.forwardAuth?.autoCreateUsers ?? true}
                      onCheckedChange={(v) => setEditConfig({
                        ...editConfig,
                        forwardAuth: { ...editConfig.forwardAuth, autoCreateUsers: v }
                      })}
                    />
                    <Label>Auto-create users from headers</Label>
                  </div>
                </div>
              )}
            </div>
            
            <div className="flex space-x-3">
              <Button
                onClick={handleSave}
                disabled={saving}
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Save className="mr-2 h-4 w-4" />
                Save Changes
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setEditConfig(config);
                  setEditing(false);
                  setError("");
                }}
                disabled={saving}
              >
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}