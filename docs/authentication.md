# Authentication Configuration

Gitea Mirror supports multiple authentication methods to integrate with your existing infrastructure:

- **Local Authentication** - Traditional username/password authentication (default)
- **Forward Authentication** - Header-based authentication for reverse proxy setups
- **OIDC/OAuth2** - OpenID Connect authentication with external providers

## Configuration Overview

Authentication is configured via environment variables. The primary method is set with `AUTH_METHOD`, and you can enable fallback to local authentication with `AUTH_ALLOW_LOCAL_FALLBACK`.

```bash
# Primary authentication method
AUTH_METHOD=local  # Options: local, forward, oidc

# Allow fallback to local auth
AUTH_ALLOW_LOCAL_FALLBACK=true
```

## Local Authentication (Default)

Traditional username/password authentication using the local database.

```bash
AUTH_METHOD=local
```

No additional configuration required. Users are managed through the application's signup/login interface.

## Forward Authentication

Perfect for reverse proxy setups like Authentik, Authelia, Traefik Forward Auth, etc.

### Configuration

```bash
AUTH_METHOD=forward

# Header configuration
AUTH_FORWARD_USER_HEADER=X-Remote-User
AUTH_FORWARD_EMAIL_HEADER=X-Remote-Email
AUTH_FORWARD_NAME_HEADER=X-Remote-Name
AUTH_FORWARD_GROUPS_HEADER=X-Remote-Groups

# Security (optional)
AUTH_FORWARD_TRUSTED_PROXIES=192.168.1.100,10.0.0.1

# Auto-create users
AUTH_FORWARD_AUTO_CREATE=true
```

### Authentik Setup Example

1. **Create Application in Authentik:**
   ```yaml
   Name: Gitea Mirror
   Slug: gitea-mirror
   Provider: Proxy Provider
   ```

2. **Configure Proxy Provider:**
   ```yaml
   Name: Gitea Mirror Proxy
   Authorization flow: default-authorization-flow
   Forward auth (single application): Yes
   External host: https://gitea-mirror.example.com
   ```

3. **Configure Headers:**
   ```yaml
   # In Authentik's Proxy Provider settings
   Additional Headers:
     X-Remote-User: {{ user.username }}
     X-Remote-Email: {{ user.email }}
     X-Remote-Name: {{ user.name }}
     X-Remote-Groups: {{ user.groups.all|join:"," }}
   ```

4. **Environment Variables:**
   ```bash
   AUTH_METHOD=forward
   AUTH_FORWARD_USER_HEADER=X-Remote-User
   AUTH_FORWARD_EMAIL_HEADER=X-Remote-Email
   AUTH_FORWARD_NAME_HEADER=X-Remote-Name
   AUTH_FORWARD_GROUPS_HEADER=X-Remote-Groups
   AUTH_FORWARD_AUTO_CREATE=true
   ```

### Traefik Forward Auth Example

```yaml
# docker-compose.yml
services:
  gitea-mirror:
    image: ghcr.io/arunavo4/gitea-mirror:latest
    environment:
      - AUTH_METHOD=forward
      - AUTH_FORWARD_USER_HEADER=X-Forwarded-User
      - AUTH_FORWARD_EMAIL_HEADER=X-Forwarded-Email
    labels:
      - "traefik.http.routers.gitea-mirror.middlewares=auth@docker"
```

## OIDC/OAuth2 Authentication

Supports standard OpenID Connect providers like Authentik, Keycloak, Auth0, Google, etc.

### Configuration

```bash
AUTH_METHOD=oidc

# OIDC Provider Configuration
AUTH_OIDC_ISSUER_URL=https://auth.example.com/application/o/gitea-mirror/
AUTH_OIDC_CLIENT_ID=your-client-id
AUTH_OIDC_CLIENT_SECRET=your-client-secret

# Optional: Custom redirect URI (auto-generated if not provided)
AUTH_OIDC_REDIRECT_URI=https://gitea-mirror.example.com/api/auth/oidc/callback

# Scopes and claims
AUTH_OIDC_SCOPES=openid,profile,email
AUTH_OIDC_USERNAME_CLAIM=preferred_username
AUTH_OIDC_EMAIL_CLAIM=email
AUTH_OIDC_NAME_CLAIM=name

# Auto-create users
AUTH_OIDC_AUTO_CREATE=true
```

### Authentik OIDC Setup Example

1. **Create OAuth2/OpenID Provider:**
   ```yaml
   Name: Gitea Mirror OIDC
   Authorization flow: default-authorization-flow
   Client type: Confidential
   Client ID: gitea-mirror
   Client Secret: [generate secure secret]
   Redirect URIs: https://gitea-mirror.example.com/api/auth/oidc/callback
   Scopes: openid, profile, email
   ```

2. **Create Application:**
   ```yaml
   Name: Gitea Mirror
   Slug: gitea-mirror
   Provider: [Select the OAuth2 provider created above]
   ```

3. **Environment Variables:**
   ```bash
   AUTH_METHOD=oidc
   AUTH_OIDC_ISSUER_URL=https://auth.example.com/application/o/gitea-mirror/
   AUTH_OIDC_CLIENT_ID=gitea-mirror
   AUTH_OIDC_CLIENT_SECRET=your-generated-secret
   AUTH_OIDC_AUTO_CREATE=true
   ```

### Keycloak Setup Example

1. **Create Client in Keycloak:**
   ```yaml
   Client ID: gitea-mirror
   Client Protocol: openid-connect
   Access Type: confidential
   Valid Redirect URIs: https://gitea-mirror.example.com/api/auth/oidc/callback
   ```

2. **Environment Variables:**
   ```bash
   AUTH_METHOD=oidc
   AUTH_OIDC_ISSUER_URL=https://keycloak.example.com/auth/realms/your-realm
   AUTH_OIDC_CLIENT_ID=gitea-mirror
   AUTH_OIDC_CLIENT_SECRET=your-client-secret
   ```

## Mixed Authentication

You can enable multiple authentication methods with fallback:

```bash
# Primary method is OIDC, but allow local fallback
AUTH_METHOD=oidc
AUTH_ALLOW_LOCAL_FALLBACK=true

# OIDC configuration
AUTH_OIDC_ISSUER_URL=https://auth.example.com/...
AUTH_OIDC_CLIENT_ID=gitea-mirror
AUTH_OIDC_CLIENT_SECRET=secret
```

This allows users to login via OIDC, but administrators can still use local accounts if needed.

## Security Considerations

1. **Forward Auth Security:**
   - Always use `AUTH_FORWARD_TRUSTED_PROXIES` in production
   - Ensure your reverse proxy strips authentication headers from external requests
   - Use HTTPS for all communication

2. **OIDC Security:**
   - Use strong client secrets
   - Validate redirect URIs carefully
   - Consider token expiration settings

3. **General:**
   - Use strong JWT secrets (`JWT_SECRET`)
   - Enable HTTPS in production
   - Regularly rotate secrets

## Troubleshooting

### Forward Auth Issues

- **Headers not received:** Check proxy configuration and header names
- **User creation fails:** Verify `AUTH_FORWARD_AUTO_CREATE=true` and required headers
- **Trusted proxy errors:** Add proxy IP to `AUTH_FORWARD_TRUSTED_PROXIES`

### OIDC Issues

- **Discovery fails:** Verify `AUTH_OIDC_ISSUER_URL` and network connectivity
- **Token exchange fails:** Check client ID/secret and redirect URI
- **User creation fails:** Verify claims configuration and `AUTH_OIDC_AUTO_CREATE=true`

### Debug Logging

Enable debug logging to troubleshoot authentication issues:

```bash
# Check application logs for authentication debug information
docker logs gitea-mirror
```
