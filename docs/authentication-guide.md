# Authentication Guide

Gitea Mirror supports multiple authentication methods to integrate with your existing infrastructure while maintaining a simple login experience by default.

## Table of Contents
- [Authentication Methods](#authentication-methods)
- [Configuration](#configuration)
- [UI Setup Wizard](#ui-setup-wizard)
- [Local Authentication (Default)](#local-authentication-default)
- [OIDC Authentication](#oidc-authentication)
- [Forward Authentication](#forward-authentication)
- [Security Best Practices](#security-best-practices)
- [Troubleshooting](#troubleshooting)

## Authentication Methods

Gitea Mirror supports three authentication methods:

1. **Local Authentication** (Default) - Simple username/password
2. **OIDC Authentication** - OpenID Connect for SSO
3. **Forward Authentication** - Header-based auth for reverse proxies

## Configuration

Authentication can be configured in two ways:

1. **UI Setup Wizard** (Recommended) - Configure authentication through the web interface during initial setup
2. **Environment Variables** - Pre-configure authentication before deployment

The UI configuration takes precedence over environment variables, allowing you to change authentication settings without restarting the application.

## UI Setup Wizard

On first run, Gitea Mirror presents a setup wizard that allows you to:

1. Choose your authentication method
2. Configure the selected method with guided forms
3. Test the configuration before saving
4. Create your first admin account

The setup wizard is accessible at `/setup` when no authentication is configured.

### Environment Variable Configuration

If you prefer to pre-configure authentication via environment variables:

```bash
# Authentication method: local (default), oidc, forward
AUTH_METHOD=local

# Allow fallback to local auth if external auth fails
AUTH_ALLOW_LOCAL_FALLBACK=false
```

Note: These can also be configured through the Admin Settings UI after initial setup.

## Local Authentication (Default)

The simplest authentication method using username and password stored in the database.

### Features
- First user automatically becomes admin
- Passwords hashed with bcrypt
- JWT tokens for session management
- No configuration required

### Usage
Simply start the application and navigate to `/login`. If no users exist, you'll be redirected to `/signup` to create the first admin account.

## OIDC Authentication

OpenID Connect authentication for Single Sign-On (SSO) with providers like:
- Authentik
- Keycloak
- Auth0
- Google
- Microsoft Azure AD
- GitHub

### Configuration

OIDC can be configured via the UI Setup Wizard or Admin Settings. For environment variable configuration:

```bash
# Enable OIDC authentication
AUTH_METHOD=oidc

# OIDC Provider Configuration
AUTH_OIDC_ISSUER_URL=https://your-provider.com/application/o/gitea-mirror/
AUTH_OIDC_CLIENT_ID=your-client-id
AUTH_OIDC_CLIENT_SECRET=your-client-secret

# Optional: Custom redirect URI (auto-generated if not set)
AUTH_OIDC_REDIRECT_URI=https://your-domain.com/api/auth/oidc/callback

# Optional: Scopes (default: openid,profile,email)
AUTH_OIDC_SCOPES=openid,profile,email,groups

# Optional: Auto-create users (default: true)
AUTH_OIDC_AUTO_CREATE=true

# Optional: Custom claim mappings
AUTH_OIDC_USERNAME_CLAIM=preferred_username
AUTH_OIDC_EMAIL_CLAIM=email
AUTH_OIDC_NAME_CLAIM=name
```

### Provider-Specific Examples

#### Authentik
```bash
AUTH_METHOD=oidc
AUTH_OIDC_ISSUER_URL=https://authentik.example.com/application/o/gitea-mirror/
AUTH_OIDC_CLIENT_ID=gitea-mirror
AUTH_OIDC_CLIENT_SECRET=your-secret-here
```

#### Keycloak
```bash
AUTH_METHOD=oidc
AUTH_OIDC_ISSUER_URL=https://keycloak.example.com/auth/realms/your-realm
AUTH_OIDC_CLIENT_ID=gitea-mirror
AUTH_OIDC_CLIENT_SECRET=your-secret-here
```

#### Google
```bash
AUTH_METHOD=oidc
AUTH_OIDC_ISSUER_URL=https://accounts.google.com
AUTH_OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com
AUTH_OIDC_CLIENT_SECRET=your-secret-here
```

### OIDC Provider Setup

1. Create a new OAuth2/OIDC application in your provider
2. Set the redirect URI to: `https://your-domain.com/api/auth/oidc/callback`
3. Grant the following scopes: `openid`, `profile`, `email`
4. Copy the client ID and secret to your environment configuration

## Forward Authentication

Header-based authentication for reverse proxy setups. Compatible with:
- Authentik (Proxy Provider)
- Authelia
- Traefik ForwardAuth
- nginx auth_request
- Any proxy that sets authentication headers

### Configuration

Forward Auth can be configured via the UI Setup Wizard or Admin Settings. For environment variable configuration:

```bash
# Enable forward authentication
AUTH_METHOD=forward

# Header Configuration
AUTH_FORWARD_USER_HEADER=X-Remote-User
AUTH_FORWARD_EMAIL_HEADER=X-Remote-Email
AUTH_FORWARD_NAME_HEADER=X-Remote-Name
AUTH_FORWARD_GROUPS_HEADER=X-Remote-Groups

# Security: Trusted proxy IPs (comma-separated)
AUTH_FORWARD_TRUSTED_PROXIES=10.0.0.1,10.0.0.2

# Auto-create users (default: true)
AUTH_FORWARD_AUTO_CREATE=true
```

### Reverse Proxy Examples

#### Traefik with Authentik
```yaml
http:
  routers:
    gitea-mirror:
      rule: "Host(`gitea-mirror.example.com`)"
      service: gitea-mirror
      middlewares:
        - authentik
      tls:
        certResolver: letsencrypt

  middlewares:
    authentik:
      forwardAuth:
        address: "http://authentik:9000/outpost.goauthentik.io/auth/traefik"
        trustForwardHeader: true
        authResponseHeaders:
          - X-Remote-User
          - X-Remote-Email
          - X-Remote-Name
          - X-Remote-Groups

  services:
    gitea-mirror:
      loadBalancer:
        servers:
          - url: "http://gitea-mirror:3000"
```

#### nginx with Authelia
```nginx
server {
    listen 443 ssl;
    server_name gitea-mirror.example.com;

    # Authelia auth_request
    auth_request /authelia;
    auth_request_set $user $upstream_http_remote_user;
    auth_request_set $email $upstream_http_remote_email;
    auth_request_set $name $upstream_http_remote_name;
    auth_request_set $groups $upstream_http_remote_groups;

    # Forward auth headers to application
    proxy_set_header X-Remote-User $user;
    proxy_set_header X-Remote-Email $email;
    proxy_set_header X-Remote-Name $name;
    proxy_set_header X-Remote-Groups $groups;

    location / {
        proxy_pass http://gitea-mirror:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /authelia {
        internal;
        proxy_pass http://authelia:9091/api/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
    }
}
```

## Security Best Practices

### JWT Configuration
```bash
# Use a strong, random JWT secret
JWT_SECRET=$(openssl rand -base64 32)
```

### OIDC Security
1. Always use HTTPS in production
2. Verify your OIDC provider's certificate
3. Limit redirect URIs in your OIDC provider
4. Use strong client secrets
5. Enable PKCE if supported by your provider

### Forward Auth Security
1. **Always configure trusted proxy IPs**
   ```bash
   AUTH_FORWARD_TRUSTED_PROXIES=10.0.0.1,10.0.0.2
   ```
2. Use internal networks for proxy communication
3. Ensure headers cannot be spoofed by clients
4. Use HTTPS between proxy and application

### General Security
1. Enable HTTPS in production (cookies will use Secure flag)
2. Keep authentication logs for auditing
3. Regularly rotate secrets and tokens
4. Monitor failed authentication attempts
5. Use strong passwords for local accounts

## Troubleshooting

### OIDC Issues

#### "Failed to fetch OIDC configuration"
- Verify `AUTH_OIDC_ISSUER_URL` is correct
- Ensure `.well-known/openid-configuration` is accessible
- Check network connectivity to OIDC provider

#### "Invalid state parameter"
- Clear browser cookies
- Ensure redirect URI matches exactly
- Check for clock skew between servers

#### "User not found and auto-creation is disabled"
- Set `AUTH_OIDC_AUTO_CREATE=true` to enable auto-creation
- Or create the user manually first

### Forward Auth Issues

#### "No auth headers found"
- Verify proxy is setting the correct headers
- Check `AUTH_FORWARD_USER_HEADER` configuration
- Enable debug logging in your reverse proxy

#### "Untrusted proxy IP"
- Add proxy IP to `AUTH_FORWARD_TRUSTED_PROXIES`
- Check X-Forwarded-For header chain
- Verify network topology

### Local Auth Issues

#### "This account uses OIDC authentication"
- User was created via OIDC and cannot use password login
- Use the appropriate authentication method
- Or enable `AUTH_ALLOW_LOCAL_FALLBACK=true`

#### Cannot access login page
- Check if forward auth is redirecting automatically
- Verify `AUTH_METHOD` is set correctly
- Clear browser cache and cookies

## Managing Authentication Settings

### Via Admin UI

Admin users can modify authentication settings through the web interface:

1. Navigate to `/admin/settings` 
2. Click on the "Authentication" tab
3. Modify settings as needed
4. Test configuration before saving
5. Changes take effect immediately without restart

### Via Environment Variables

Environment variables are checked on startup and used as defaults if no database configuration exists.

### Configuration Precedence

1. Database configuration (set via UI) takes highest precedence
2. Environment variables are used as fallback
3. Built-in defaults apply if neither is set

## Migration Guide

### Switching from Local to OIDC

1. As an admin, go to `/admin/settings` → Authentication
2. Enable "Allow Local Fallback" temporarily
3. Configure OIDC settings and test
4. Once verified, disable local fallback

Alternatively, via environment variables:
```bash
AUTH_METHOD=oidc
AUTH_ALLOW_LOCAL_FALLBACK=true
# ... OIDC configuration ...
```

### Adding Forward Auth to Existing Setup

1. Configure your reverse proxy first
2. Test headers are being set correctly
3. Update authentication settings via UI or environment:
   ```bash
   AUTH_METHOD=forward
   AUTH_FORWARD_TRUSTED_PROXIES=your-proxy-ip
   ```

## Support

For authentication issues:
1. Check the logs for detailed error messages
2. Verify environment variables are set correctly
3. Test with `AUTH_ALLOW_LOCAL_FALLBACK=true` for debugging
4. Report issues at: https://github.com/your-repo/gitea-mirror/issues