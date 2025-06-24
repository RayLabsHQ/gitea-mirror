# OIDC Testing Guide

This guide walks through setting up and testing OIDC authentication with Gitea Mirror.

## Quick Start

### 1. Local Authentication (Default)
```bash
# Use the standard docker-compose.yml
docker compose up -d

# Access at http://localhost:4321
# First user signup becomes admin
```

### 2. OIDC Authentication

#### Option A: Using Authentik (Recommended for Testing)

1. **Set up Authentik** (if not already running):
```bash
# Create authentik docker-compose.yml
cat > authentik-compose.yml << 'EOF'
version: '3.4'

services:
  postgresql:
    image: postgres:12-alpine
    restart: unless-stopped
    volumes:
      - database:/var/lib/postgresql/data
    environment:
      - POSTGRES_PASSWORD=authentik
      - POSTGRES_USER=authentik
      - POSTGRES_DB=authentik

  redis:
    image: redis:alpine
    restart: unless-stopped

  server:
    image: ghcr.io/goauthentik/server:latest
    restart: unless-stopped
    command: server
    environment:
      AUTHENTIK_REDIS__HOST: redis
      AUTHENTIK_POSTGRESQL__HOST: postgresql
      AUTHENTIK_POSTGRESQL__USER: authentik
      AUTHENTIK_POSTGRESQL__NAME: authentik
      AUTHENTIK_POSTGRESQL__PASSWORD: authentik
      AUTHENTIK_SECRET_KEY: "changeme-to-a-secret-key"
      AUTHENTIK_ERROR_REPORTING__ENABLED: "false"
    volumes:
      - ./media:/media
      - ./custom-templates:/templates
    ports:
      - "9000:9000"
    depends_on:
      - postgresql
      - redis

  worker:
    image: ghcr.io/goauthentik/server:latest
    restart: unless-stopped
    command: worker
    environment:
      AUTHENTIK_REDIS__HOST: redis
      AUTHENTIK_POSTGRESQL__HOST: postgresql
      AUTHENTIK_POSTGRESQL__USER: authentik
      AUTHENTIK_POSTGRESQL__NAME: authentik
      AUTHENTIK_POSTGRESQL__PASSWORD: authentik
      AUTHENTIK_SECRET_KEY: "changeme-to-a-secret-key"
    volumes:
      - ./media:/media
      - ./custom-templates:/templates
    depends_on:
      - postgresql
      - redis

volumes:
  database:
EOF

docker compose -f authentik-compose.yml up -d
```

2. **Configure Authentik**:
   - Access Authentik at http://localhost:9000
   - Create initial admin user
   - Create an OAuth2/OIDC provider:
     - Go to Applications → Providers → Create
     - Choose "OAuth2/OpenID Provider"
     - Name: `gitea-mirror`
     - Client ID: `gitea-mirror`
     - Client Secret: Generate one and save it
     - Redirect URIs: `http://localhost:4321/api/auth/oidc/callback`
   - Create an Application:
     - Go to Applications → Applications → Create
     - Name: `Gitea Mirror`
     - Slug: `gitea-mirror`
     - Provider: Select the provider you just created

3. **Configure Gitea Mirror**:
```bash
# Create .env file
cat > .env << 'EOF'
# OIDC Configuration
AUTH_METHOD=oidc
AUTH_OIDC_ISSUER_URL=http://localhost:9000/application/o/gitea-mirror/
AUTH_OIDC_CLIENT_ID=gitea-mirror
AUTH_OIDC_CLIENT_SECRET=your-secret-from-authentik
AUTH_ALLOW_LOCAL_FALLBACK=true  # For testing
EOF

# Start Gitea Mirror with OIDC
docker compose -f docker-compose.oidc.yml up -d
```

#### Option B: Using Keycloak

```bash
# Quick Keycloak setup
docker run -d --name keycloak \
  -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev

# Configure in Keycloak UI (http://localhost:8080)
# Create realm, client, and user

# Update .env
AUTH_OIDC_ISSUER_URL=http://localhost:8080/realms/your-realm
AUTH_OIDC_CLIENT_ID=gitea-mirror
AUTH_OIDC_CLIENT_SECRET=your-client-secret
```

### 3. Forward Authentication (Traefik + Authentik)

```yaml
# traefik-compose.yml
version: '3'

services:
  traefik:
    image: traefik:v3.0
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--entrypoints.web.address=:80"
    ports:
      - "80:80"
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - proxy-network

  gitea-mirror:
    extends:
      file: docker-compose.forward-auth.yml
      service: gitea-mirror
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.gitea-mirror.rule=Host(`gitea-mirror.localhost`)"
      - "traefik.http.routers.gitea-mirror.middlewares=authentik@docker"
      - "traefik.http.middlewares.authentik.forwardauth.address=http://authentik-server:9000/outpost.goauthentik.io/auth/traefik"
      - "traefik.http.middlewares.authentik.forwardauth.trustForwardHeader=true"
      - "traefik.http.middlewares.authentik.forwardauth.authResponseHeaders=X-Remote-User,X-Remote-Email,X-Remote-Name,X-Remote-Groups"
    environment:
      - AUTH_METHOD=forward
      - AUTH_FORWARD_TRUSTED_PROXIES=172.16.0.0/12  # Docker network range

networks:
  proxy-network:
    external: true
```

## Testing Scenarios

### 1. Test OIDC Login
```bash
# 1. Start with local auth to create test data
AUTH_METHOD=local docker compose up -d
# Create a local user and some test data

# 2. Switch to OIDC with fallback
AUTH_METHOD=oidc AUTH_ALLOW_LOCAL_FALLBACK=true docker compose up -d
# Test that:
# - OIDC login button appears
# - Local login still works
# - New OIDC users are created

# 3. Disable local fallback
AUTH_METHOD=oidc AUTH_ALLOW_LOCAL_FALLBACK=false docker compose up -d
# Test that:
# - Only OIDC login is available
# - Local users can't login with password
```

### 2. Test Forward Auth
```bash
# With Traefik + Authentik
docker compose -f traefik-compose.yml up -d

# Access via http://gitea-mirror.localhost
# Should redirect to Authentik login
# After login, headers are passed to app
```

### 3. Test Security Features

#### OIDC State Validation
```bash
# Try to access callback directly
curl http://localhost:4321/api/auth/oidc/callback?code=fake
# Should fail with "Missing authorization code" or "Invalid state"
```

#### Forward Auth Proxy Validation
```bash
# Try to spoof headers
curl -H "X-Remote-User: fakeuser" \
     -H "X-Remote-Email: fake@example.com" \
     http://localhost:4321/api/user
# Should fail if TRUSTED_PROXIES is configured
```

## Environment Variables Reference

### OIDC Mode
```bash
AUTH_METHOD=oidc
AUTH_OIDC_ISSUER_URL=https://your-provider.com/application/o/gitea-mirror/
AUTH_OIDC_CLIENT_ID=gitea-mirror
AUTH_OIDC_CLIENT_SECRET=your-secret
AUTH_OIDC_REDIRECT_URI=https://your-domain.com/api/auth/oidc/callback  # Optional
AUTH_OIDC_SCOPES=openid,profile,email  # Optional
AUTH_OIDC_AUTO_CREATE=true  # Optional
AUTH_ALLOW_LOCAL_FALLBACK=false  # Optional
```

### Forward Auth Mode
```bash
AUTH_METHOD=forward
AUTH_FORWARD_USER_HEADER=X-Remote-User
AUTH_FORWARD_EMAIL_HEADER=X-Remote-Email
AUTH_FORWARD_NAME_HEADER=X-Remote-Name  # Optional
AUTH_FORWARD_GROUPS_HEADER=X-Remote-Groups  # Optional
AUTH_FORWARD_TRUSTED_PROXIES=172.16.0.0/12,10.0.0.1  # Important!
AUTH_FORWARD_AUTO_CREATE=true
```

## Debugging

### Check Authentication Config
```bash
# View current auth configuration
curl http://localhost:4321/api/auth/config
```

### Check Logs
```bash
# View container logs
docker compose logs -f gitea-mirror

# Look for:
# - "OIDC: Created new user..."
# - "Forward Auth: Created new user..."
# - "JWT signature validation not implemented" (warning in dev)
```

### Common Issues

1. **"Failed to fetch OIDC configuration"**
   - Check ISSUER_URL is accessible from container
   - Try with container name if using Docker network

2. **"Invalid state parameter"**
   - Clear browser cookies
   - Check redirect URI matches exactly

3. **"Untrusted proxy IP"**
   - Add proxy IP to TRUSTED_PROXIES
   - Check Docker network range

4. **Can't login after switching auth methods**
   - Enable AUTH_ALLOW_LOCAL_FALLBACK temporarily
   - Check user's authProvider in database

## Production Deployment

1. **Use HTTPS** - Required for secure cookies
2. **Set strong secrets** - JWT_SECRET is auto-generated
3. **Configure trusted proxies** - Prevent header spoofing
4. **Disable local fallback** - Unless specifically needed
5. **Monitor auth logs** - Track failed attempts

## Reset to Local Auth

If you need to go back to simple local authentication:

```bash
# Stop container
docker compose down

# Reset to local auth
docker compose up -d
# or explicitly:
AUTH_METHOD=local docker compose up -d
```

The JWT_SECRET is automatically managed by the Docker entrypoint script, so you don't need to set it manually.