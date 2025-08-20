# Environment Variables Documentation

This document provides a comprehensive list of all environment variables supported by Gitea Mirror. These can be used to configure the application via Docker or other deployment methods.

## Table of Contents

- [Core Configuration](#core-configuration)
- [GitHub Configuration](#github-configuration)
- [Gitea Configuration](#gitea-configuration)
- [Mirror Options](#mirror-options)
- [Automation Configuration](#automation-configuration)
- [Database Cleanup Configuration](#database-cleanup-configuration)
- [Authentication Configuration](#authentication-configuration)
- [Docker Configuration](#docker-configuration)

## Core Configuration

Essential application settings required for running Gitea Mirror.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `NODE_ENV` | Application environment | `production` | No |
| `HOST` | Server host binding | `0.0.0.0` | No |
| `PORT` | Server port | `4321` | No |
| `DATABASE_URL` | Database connection URL | `sqlite://data/gitea-mirror.db` | No |
| `BETTER_AUTH_SECRET` | Secret key for session signing (generate with: `openssl rand -base64 32`) | - | Yes |
| `BETTER_AUTH_URL` | Base URL for authentication | `http://localhost:4321` | No |
| `ENCRYPTION_SECRET` | Optional encryption key for tokens (generate with: `openssl rand -base64 48`) | - | No |

## GitHub Configuration

Settings for connecting to and configuring GitHub repository sources.

### Basic Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `GITHUB_USERNAME` | Your GitHub username | - | - |
| `GITHUB_TOKEN` | GitHub personal access token (requires repo and admin:org scopes) | - | - |
| `GITHUB_TYPE` | GitHub account type | `personal` | `personal`, `organization` |

### Repository Selection

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `PRIVATE_REPOSITORIES` | Include private repositories | `false` | `true`, `false` |
| `PUBLIC_REPOSITORIES` | Include public repositories | `true` | `true`, `false` |
| `INCLUDE_ARCHIVED` | Include archived repositories | `false` | `true`, `false` |
| `SKIP_FORKS` | Skip forked repositories | `false` | `true`, `false` |
| `MIRROR_STARRED` | Mirror starred repositories | `false` | `true`, `false` |
| `STARRED_REPOS_ORG` | Organization name for starred repos | `starred` | Any string |

### Organization Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `MIRROR_ORGANIZATIONS` | Mirror organization repositories | `false` | `true`, `false` |
| `PRESERVE_ORG_STRUCTURE` | Preserve GitHub organization structure in Gitea | `false` | `true`, `false` |
| `ONLY_MIRROR_ORGS` | Only mirror organization repos (skip personal) | `false` | `true`, `false` |
| `MIRROR_STRATEGY` | Repository organization strategy | `preserve` | `preserve`, `single-org`, `flat-user`, `mixed` |

### Advanced Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `SKIP_STARRED_ISSUES` | Enable lightweight mode for starred repos (skip issues) | `false` | `true`, `false` |

## Gitea Configuration

Settings for the destination Gitea instance.

### Connection Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `GITEA_URL` | Gitea instance URL | - | Valid URL |
| `GITEA_TOKEN` | Gitea access token | - | - |
| `GITEA_USERNAME` | Gitea username | - | - |
| `GITEA_ORGANIZATION` | Default organization for single-org strategy | `github-mirrors` | Any string |

### Repository Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `GITEA_ORG_VISIBILITY` | Default organization visibility | `public` | `public`, `private`, `limited`, `default` |
| `GITEA_MIRROR_INTERVAL` | Mirror sync interval (automatically enables scheduler) | `8h` | Duration string (e.g., `30m`, `1h`, `8h`, `24h`) |
| `GITEA_LFS` | Enable LFS support | `false` | `true`, `false` |
| `GITEA_CREATE_ORG` | Auto-create organizations | `true` | `true`, `false` |
| `GITEA_PRESERVE_VISIBILITY` | Preserve GitHub repo visibility in Gitea | `false` | `true`, `false` |

### Template Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `GITEA_TEMPLATE_OWNER` | Template repository owner | - | Any string |
| `GITEA_TEMPLATE_REPO` | Template repository name | - | Any string |

### Topic Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `GITEA_ADD_TOPICS` | Add topics to repositories | `true` | `true`, `false` |
| `GITEA_TOPIC_PREFIX` | Prefix for repository topics | - | Any string |

### Fork Handling

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `GITEA_FORK_STRATEGY` | How to handle forked repositories | `reference` | `skip`, `reference`, `full-copy` |

### Additional Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `GITEA_SKIP_TLS_VERIFY` | Skip TLS certificate verification (WARNING: insecure) | `false` | `true`, `false` |

## Mirror Options

Control what content gets mirrored from GitHub to Gitea.

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `MIRROR_RELEASES` | Mirror GitHub releases | `false` | `true`, `false` |
| `MIRROR_WIKI` | Mirror wiki content | `false` | `true`, `false` |
| `MIRROR_METADATA` | Master toggle for metadata mirroring | `false` | `true`, `false` |
| `MIRROR_ISSUES` | Mirror issues (requires MIRROR_METADATA=true) | `false` | `true`, `false` |
| `MIRROR_PULL_REQUESTS` | Mirror pull requests (requires MIRROR_METADATA=true) | `false` | `true`, `false` |
| `MIRROR_LABELS` | Mirror labels (requires MIRROR_METADATA=true) | `false` | `true`, `false` |
| `MIRROR_MILESTONES` | Mirror milestones (requires MIRROR_METADATA=true) | `false` | `true`, `false` |

## Automation Configuration

Configure automatic scheduled mirroring.

### Basic Schedule Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `SCHEDULE_ENABLED` | Enable automatic mirroring | `false` | `true`, `false` |
| `SCHEDULE_INTERVAL` | Interval in seconds or cron expression | `3600` | Number or cron string (e.g., `"0 2 * * *"`) |
| `DELAY` | Legacy: same as SCHEDULE_INTERVAL | `3600` | Number (seconds) |

### Execution Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `SCHEDULE_CONCURRENT` | Allow concurrent mirror operations | `false` | `true`, `false` |
| `SCHEDULE_BATCH_SIZE` | Number of repos to process in parallel | `10` | Number |
| `SCHEDULE_PAUSE_BETWEEN_BATCHES` | Pause between batches (milliseconds) | `5000` | Number |

### Retry Configuration

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `SCHEDULE_RETRY_ATTEMPTS` | Number of retry attempts | `3` | Number |
| `SCHEDULE_RETRY_DELAY` | Delay between retries (milliseconds) | `60000` | Number |
| `SCHEDULE_TIMEOUT` | Max time for a mirror operation (milliseconds) | `3600000` | Number |
| `SCHEDULE_AUTO_RETRY` | Automatically retry failed operations | `true` | `true`, `false` |

### Update Detection

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `SCHEDULE_ONLY_MIRROR_UPDATED` | Only mirror repos with updates | `false` | `true`, `false` |
| `SCHEDULE_UPDATE_INTERVAL` | Check for updates interval (milliseconds) | `86400000` | Number |
| `SCHEDULE_SKIP_RECENTLY_MIRRORED` | Skip recently mirrored repos | `true` | `true`, `false` |
| `SCHEDULE_RECENT_THRESHOLD` | Skip if mirrored within this time (milliseconds) | `3600000` | Number |

### Maintenance & Notifications

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `SCHEDULE_CLEANUP_BEFORE_MIRROR` | Run cleanup before mirroring | `false` | `true`, `false` |
| `SCHEDULE_NOTIFY_ON_FAILURE` | Send notifications on failure | `true` | `true`, `false` |
| `SCHEDULE_NOTIFY_ON_SUCCESS` | Send notifications on success | `false` | `true`, `false` |
| `SCHEDULE_LOG_LEVEL` | Logging level | `info` | `error`, `warn`, `info`, `debug` |
| `SCHEDULE_TIMEZONE` | Timezone for scheduling | `UTC` | Valid timezone string |

## Database Cleanup Configuration

Configure automatic cleanup of old events and data.

### Basic Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `CLEANUP_ENABLED` | Enable automatic cleanup | `false` | `true`, `false` |
| `CLEANUP_RETENTION_DAYS` | Days to keep events | `7` | Number |

### Repository Cleanup

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `CLEANUP_DELETE_FROM_GITEA` | Delete repositories from Gitea | `false` | `true`, `false` |
| `CLEANUP_DELETE_IF_NOT_IN_GITHUB` | Delete repos not found in GitHub (automatically enables cleanup) | `true` | `true`, `false` |
| `CLEANUP_ORPHANED_REPO_ACTION` | Action for orphaned repositories | `archive` | `skip`, `archive`, `delete` |
| `CLEANUP_DRY_RUN` | Test mode without actual deletion | `true` | `true`, `false` |
| `CLEANUP_PROTECTED_REPOS` | Comma-separated list of protected repository names | - | Comma-separated strings |

### Execution Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `CLEANUP_BATCH_SIZE` | Number of items to process per batch | `10` | Number |
| `CLEANUP_PAUSE_BETWEEN_DELETES` | Pause between deletions (milliseconds) | `2000` | Number |

## Authentication Configuration

Configure authentication methods and SSO.

### Header Authentication (Reverse Proxy SSO)

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `HEADER_AUTH_ENABLED` | Enable header-based authentication | `false` | `true`, `false` |
| `HEADER_AUTH_USER_HEADER` | Header containing username | `X-Authentik-Username` | Header name |
| `HEADER_AUTH_EMAIL_HEADER` | Header containing email | `X-Authentik-Email` | Header name |
| `HEADER_AUTH_NAME_HEADER` | Header containing display name | `X-Authentik-Name` | Header name |
| `HEADER_AUTH_AUTO_PROVISION` | Auto-create users from headers | `false` | `true`, `false` |
| `HEADER_AUTH_ALLOWED_DOMAINS` | Comma-separated list of allowed email domains | - | Comma-separated domains |

## Docker Configuration

Settings specific to Docker deployments.

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `DOCKER_REGISTRY` | Docker registry URL | `ghcr.io` | Registry URL |
| `DOCKER_IMAGE` | Docker image name | `arunavo4/gitea-mirror` | Image name |
| `DOCKER_TAG` | Docker image tag | `latest` | Tag name |

## Example Docker Compose Configuration

Here's an example of how to use these environment variables in a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  gitea-mirror:
    image: ghcr.io/raylabshq/gitea-mirror:latest
    container_name: gitea-mirror
    environment:
      # Core Configuration
      - NODE_ENV=production
      - DATABASE_URL=file:data/gitea-mirror.db
      - BETTER_AUTH_SECRET=your-secure-secret-here
      - BETTER_AUTH_URL=https://your-domain.com
      
      # GitHub Configuration
      - GITHUB_USERNAME=your-username
      - GITHUB_TOKEN=ghp_your_token_here
      - PRIVATE_REPOSITORIES=true
      - MIRROR_STARRED=true
      - SKIP_FORKS=false
      
      # Gitea Configuration
      - GITEA_URL=http://gitea:3000
      - GITEA_USERNAME=admin
      - GITEA_TOKEN=your-gitea-token
      - GITEA_ORGANIZATION=github-mirrors
      - GITEA_ORG_VISIBILITY=public
      
      # Mirror Options
      - MIRROR_RELEASES=true
      - MIRROR_WIKI=true
      - MIRROR_METADATA=true
      - MIRROR_ISSUES=true
      - MIRROR_PULL_REQUESTS=true
      
      # Automation
      - SCHEDULE_ENABLED=true
      - SCHEDULE_INTERVAL=3600
      
      # Cleanup
      - CLEANUP_ENABLED=true
      - CLEANUP_RETENTION_DAYS=30
    volumes:
      - ./data:/app/data
    ports:
      - "4321:4321"
```

## Notes

1. **First Run**: Environment variables are loaded when the container starts. The configuration is applied after the first user account is created.

2. **UI Priority**: Manual changes made through the web UI will be preserved. Environment variables only set values for empty fields.

3. **Token Security**: All tokens are encrypted before being stored in the database.

4. **Backward Compatibility**: The `DELAY` variable is maintained for backward compatibility but `SCHEDULE_INTERVAL` is preferred.

5. **Required Scopes**: The GitHub token requires the following scopes:
   - `repo` (full control of private repositories)
   - `admin:org` (read organization data)
   - Additional scopes may be required for specific features

For more examples and detailed configuration, see the `.env.example` file in the repository.