# Gitea Mirror User Guide

This guide covers everything you need to know to use and deploy Gitea Mirror.

## Table of Contents
- [Quick Start](#quick-start)
- [Installation Methods](#installation-methods)
- [Authentication Setup](#authentication-setup)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## Quick Start

### Simplest Setup (Local Auth)

```bash
# 1. Clone the repository
git clone https://github.com/arunavo4/gitea-mirror.git
cd gitea-mirror

# 2. Start with Docker
docker compose up -d

# 3. Access at http://localhost:4321
# 4. Create your admin account (first user)
```

That's it! No configuration needed for basic usage.

## Installation Methods

### Method 1: Docker Compose (Recommended)

**For beginners:** This is the easiest way to get started.

```bash
# Basic setup
docker compose up -d

# With custom settings (create .env file first)
docker compose --env-file .env up -d

# View logs
docker compose logs -f
```

### Method 2: Docker Run

```bash
# Create a volume for data persistence
docker volume create gitea-mirror-data

# Run the container
docker run -d \
  --name gitea-mirror \
  -p 4321:4321 \
  -v gitea-mirror-data:/app/data \
  ghcr.io/arunavo4/gitea-mirror:latest
```

### Method 3: Proxmox LXC Container

For Proxmox users:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/gitea-mirror.sh)"
```

### Method 4: Manual Installation

For developers or advanced users:

```bash
# Install Bun runtime
curl -fsSL https://bun.sh/install | bash

# Install and run
bun install
bun run setup
bun run build
bun run start
```

## Authentication Setup

### Option 1: Local Authentication (Default)

No setup required! Just create users through the web interface.

- First user becomes admin
- Simple username/password login
- Perfect for small teams or personal use

### Option 2: Single Sign-On (OIDC)

Connect to your existing identity provider (Authentik, Keycloak, Google, etc.)

#### Quick Setup with Authentik

1. **In Authentik:**
   - Create Provider: OAuth2/OpenID Provider
   - Name: `gitea-mirror`
   - Client ID: `gitea-mirror`
   - Redirect URI: `http://your-domain:4321/api/auth/oidc/callback`

2. **In Gitea Mirror (.env file):**
```bash
AUTH_METHOD=oidc
AUTH_OIDC_ISSUER_URL=https://authentik.example.com/application/o/gitea-mirror/
AUTH_OIDC_CLIENT_ID=gitea-mirror
AUTH_OIDC_CLIENT_SECRET=your-secret-here
```

#### Other Providers

**Keycloak:**
```bash
AUTH_OIDC_ISSUER_URL=https://keycloak.example.com/realms/your-realm
```

**Google:**
```bash
AUTH_OIDC_ISSUER_URL=https://accounts.google.com
AUTH_OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

### Option 3: Reverse Proxy Authentication

For users already using Authentik/Authelia with reverse proxy:

```bash
AUTH_METHOD=forward
AUTH_FORWARD_USER_HEADER=X-Remote-User
AUTH_FORWARD_EMAIL_HEADER=X-Remote-Email
AUTH_FORWARD_TRUSTED_PROXIES=10.0.0.1,10.0.0.2  # Your proxy IPs
```

## Configuration

### Basic Settings

Create a `.env` file in the project root:

```bash
# Server settings
PORT=4321
HOST=0.0.0.0

# Database (auto-created)
DATABASE_URL=sqlite://data/gitea-mirror.db

# Security (auto-generated if not set)
JWT_SECRET=your-secret-key
```

### GitHub & Gitea Configuration

Configure through the web UI or environment variables:

```bash
# GitHub settings
GITHUB_USERNAME=your-username
GITHUB_TOKEN=ghp_your_personal_access_token

# Gitea settings
GITEA_URL=https://gitea.example.com
GITEA_TOKEN=your-gitea-token
GITEA_USERNAME=your-gitea-username
GITEA_ORGANIZATION=github-mirrors  # Optional
```

### Mirror Strategies

Choose how repositories are organized in Gitea:

1. **Preserve Structure** - Keeps GitHub organization structure
2. **Single Organization** - All repos in one Gitea organization  
3. **Flat User** - All repos under your user account
4. **Mixed Mode** - Personal repos in org, others preserve structure

Set in the web UI under Configuration → Organization Strategy.

## Docker Compose Examples

### Production with Traefik

```yaml
version: '3.8'

services:
  gitea-mirror:
    image: ghcr.io/arunavo4/gitea-mirror:latest
    restart: unless-stopped
    volumes:
      - gitea-mirror-data:/app/data
    environment:
      - NODE_ENV=production
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.gitea-mirror.rule=Host(`mirror.example.com`)"
      - "traefik.http.routers.gitea-mirror.tls=true"
      - "traefik.http.routers.gitea-mirror.tls.certresolver=letsencrypt"
    networks:
      - traefik

volumes:
  gitea-mirror-data:

networks:
  traefik:
    external: true
```

### Development Setup

```yaml
version: '3.8'

services:
  gitea-mirror:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./.env:/app/.env
    environment:
      - NODE_ENV=development
```

## Troubleshooting

### Common Issues

**"Cannot connect to database"**
- Ensure the data directory is writable
- Check Docker volume permissions
- Try: `docker compose down -v` and restart

**"Authentication failed"**
- Check your OIDC provider settings
- Verify redirect URI matches exactly
- Enable `AUTH_ALLOW_LOCAL_FALLBACK=true` for testing

**"No repos appearing"**
- Verify GitHub token has correct permissions
- Check Gitea token and URL
- Look at logs: `docker compose logs -f`

### Getting Help

1. Check logs first:
   ```bash
   docker compose logs gitea-mirror
   ```

2. For auth issues, check:
   ```bash
   curl http://localhost:4321/api/auth/config
   ```

3. Database issues:
   ```bash
   docker exec gitea-mirror sqlite3 /app/data/gitea-mirror.db ".tables"
   ```

### Reset Everything

```bash
# Stop and remove everything
docker compose down -v

# Start fresh
docker compose up -d
```

## Security Best Practices

1. **Use HTTPS in production** - Required for secure cookies
2. **Set strong secrets** - JWT_SECRET is auto-generated 
3. **Limit GitHub token scope** - Only grant necessary permissions
4. **Regular updates** - Pull latest Docker images
5. **Backup database** - Located at `data/gitea-mirror.db`

## Backup & Restore

### Backup

```bash
# Backup database
docker exec gitea-mirror sqlite3 /app/data/gitea-mirror.db ".backup /app/data/backup.db"

# Copy backup locally
docker cp gitea-mirror:/app/data/backup.db ./backup.db
```

### Restore

```bash
# Copy backup to container
docker cp ./backup.db gitea-mirror:/app/data/backup.db

# Restore database
docker exec gitea-mirror sqlite3 /app/data/gitea-mirror.db ".restore /app/data/backup.db"
```

## Next Steps

- Configure automatic mirroring schedules in the web UI
- Set up organization mirroring for team repositories
- Customize repository destinations as needed
- Enable issue and wiki mirroring if desired

For advanced development setup, see the [Developer Guide](./DEVELOPER_GUIDE.md).