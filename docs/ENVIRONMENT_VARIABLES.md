# Environment Variables Documentation

This document provides a comprehensive list of all environment variables supported by Gitea Mirror. These can be used to configure the application via Docker or other deployment methods.

## Environment Variables and UI Interaction

When environment variables are set:
1. They are loaded on application startup
2. Values are stored in the database on first load
3. The UI will display these values and they can be modified
4. UI changes are saved to the database and persist
5. Environment variables provide initial defaults but don't override UI changes

**Note**: Some critical settings like `GITEA_LFS`, `MIRROR_RELEASES`, and `MIRROR_METADATA` will be visible and configurable in the UI even when set via environment variables.

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
| `BETTER_AUTH_URL` | Primary base URL for authentication. This should be the main URL where your application is accessed. | `http://localhost:4321` | No |
| `PUBLIC_BETTER_AUTH_URL` | Client-side auth URL for multi-origin access. Set this to your primary domain when you need to access the app from different origins (e.g., both IP and domain). The client will use this URL for all auth requests instead of the current browser origin. | - | No |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Trusted origins for authentication requests. Comma-separated list of URLs. Use this to specify additional access URLs (e.g., local IP + domain: `http://10.10.20.45:4321,https://gitea-mirror.mydomain.tld`), SSO providers, reverse proxies, etc. | - | No |
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
| `MIRROR_STARRED_LISTS` | Optional comma-separated GitHub Star List names to mirror (only used when `MIRROR_STARRED=true`) | - | Comma-separated list names (empty = all starred repos) |
| `STARRED_REPOS_ORG` | Organization name for starred repos | `starred` | Any string |
| `STARRED_REPOS_MODE` | How starred repos are mirrored | `dedicated-org` | `dedicated-org`, `preserve-owner` |

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
| `AUTO_MIRROR_STARRED` | Automatically mirror starred repos during scheduled syncs and "Mirror All". When `false`, starred repos are imported for browsing but must be mirrored individually. | `false` | `true`, `false` |

## Gitea Configuration

Settings for the destination Gitea instance.

### Connection Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `GITEA_URL` | Gitea instance URL | - | Valid URL |
| `GITEA_EXTERNAL_URL` | Optional external/browser URL used for dashboard links. API and mirroring still use `GITEA_URL`. | - | Valid URL |
| `GITEA_TOKEN` | Gitea access token | - | - |
| `GITEA_USERNAME` | Gitea username | - | - |
| `GITEA_ORGANIZATION` | Default organization for single-org strategy | `github-mirrors` | Any string |

### Repository Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `GITEA_ORG_VISIBILITY` | Default organization visibility | `public` | `public`, `private`, `limited`, `default` |
| `GITEA_MIRROR_INTERVAL` | Mirror sync interval - **automatically enables scheduled mirroring when set** | `8h` | Duration string (e.g., `30m`, `1h`, `8h`, `24h`, `1d`) or seconds |
| `GITEA_LFS` | Enable LFS support (requires LFS on Gitea server) - Shows in UI | `false` | `true`, `false` |
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
| `RELEASE_LIMIT` | Maximum number of releases to mirror per repository | `10` | Number (1-100) |
| `MIRROR_WIKI` | Mirror wiki content | `false` | `true`, `false` |
| `MIRROR_METADATA` | Master toggle for metadata mirroring | `false` | `true`, `false` |
| `MIRROR_ISSUES` | Mirror issues (requires MIRROR_METADATA=true) | `false` | `true`, `false` |
| `MIRROR_PULL_REQUESTS` | Mirror pull requests (requires MIRROR_METADATA=true) | `false` | `true`, `false` |
| `MIRROR_LABELS` | Mirror labels (requires MIRROR_METADATA=true) | `false` | `true`, `false` |
| `MIRROR_MILESTONES` | Mirror milestones (requires MIRROR_METADATA=true) | `false` | `true`, `false` |
| `MIRROR_ISSUE_CONCURRENCY` | Number of issues processed in parallel. Set above `1` to speed up mirroring at the risk of out-of-order creation. | `3` | Integer ≥ 1 |
| `MIRROR_PULL_REQUEST_CONCURRENCY` | Number of pull requests processed in parallel. Values above `1` may cause ordering differences. | `5` | Integer ≥ 1 |

> **Ordering vs Throughput:** Metadata now mirrors sequentially by default to preserve chronology. Increase the concurrency variables only if you can tolerate minor out-of-order entries.

## Automation Configuration

Configure automatic scheduled mirroring.

### Basic Schedule Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `SCHEDULE_ENABLED` | Enable automatic mirroring. **When set to `true`, automatically imports and mirrors all repositories on startup** (v3.5.3+) | `false` | `true`, `false` |
| `SCHEDULE_INTERVAL` | Interval in seconds or cron expression. **Supports cron syntax for scheduled runs** (e.g., `"0 2 * * *"` for 2 AM daily) | `3600` | Number (seconds) or cron string |
| `DELAY` | Legacy: same as SCHEDULE_INTERVAL | `3600` | Number (seconds) |

> **🚀 Auto-Start Feature (v3.5.3+)**  
> Setting either `SCHEDULE_ENABLED=true` or `GITEA_MIRROR_INTERVAL` triggers auto-start functionality where the service will:
> 1. **Import** all GitHub repositories on startup
> 2. **Mirror** them to Gitea immediately
> 3. **Continue syncing** at the configured interval
> 4. **Auto-discover** new repositories
> 5. **Clean up** deleted repositories (if configured)
> 
> This eliminates the need for manual button clicks - perfect for Docker/Kubernetes deployments!

> **⏰ Scheduling with Cron Expressions**  
> Use cron expressions in `SCHEDULE_INTERVAL` to run at specific times:
> - `"0 2 * * *"` - Daily at 2 AM
> - `"0 */6 * * *"` - Every 6 hours
> - `"0 0 * * 0"` - Weekly on Sunday at midnight
> - `"0 3 * * 1-5"` - Weekdays at 3 AM (Monday-Friday)
> 
> This is useful for optimizing bandwidth usage during low-activity periods.

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
| `AUTO_IMPORT_REPOS` | Automatically discover and import new GitHub repositories during scheduled syncs | `true` | `true`, `false` |
| `AUTO_MIRROR_REPOS` | Automatically mirror newly imported repositories during scheduled syncs (no manual “Mirror All” required) | `false` | `true`, `false` |
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
| `CLEANUP_ORPHANED_REPO_ACTION` | Action for orphaned repositories. **Note**: `archive` is recommended to preserve backups | `archive` | `skip`, `archive`, `delete` |
| `CLEANUP_DRY_RUN` | Test mode without actual deletion | `false` | `true`, `false` |
| `CLEANUP_PROTECTED_REPOS` | Comma-separated list of protected repository names | - | Comma-separated strings |

**🛡️ Safety Features (Backup Protection)**:
- **GitHub Failures Don't Delete Backups**: Cleanup is automatically skipped if GitHub API returns errors (404, 403, connection issues)
- **Archive Never Deletes**: The `archive` action ALWAYS preserves repository data, it never deletes
- **Graceful Degradation**: If marking as archived fails, the repository remains fully accessible in Gitea
- **The Purpose of Backups**: Your mirrors are preserved even when GitHub sources disappear - that's the whole point!

**Archive Behavior (Aligned with Gitea API)**:
- **Regular repositories**: Uses Gitea's native archive feature (PATCH `/repos/{owner}/{repo}` with `archived: true`)
  - Makes repository read-only while preserving all data
- **Mirror repositories**: Uses rename strategy (Gitea API returns 422 for archiving mirrors)
  - Renamed with `archived-` prefix for clear identification
  - Description updated with preservation notice and timestamp
  - Mirror interval set to 8760h (1 year) to minimize sync attempts
  - Repository remains fully accessible and cloneable
- **Manual Sync Option**: Archived mirrors are still available on the Repositories page with automatic syncs disabled—use the `Manual Sync` action to refresh them on demand.

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
| `DOCKER_IMAGE` | Docker image name | `raylabshq/gitea-mirror:` | Image name |
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
      # Primary access URL:
      - BETTER_AUTH_URL=https://gitea-mirror.mydomain.tld
      # Additional access URLs (local network + SSO providers):
      # - BETTER_AUTH_TRUSTED_ORIGINS=http://10.10.20.45:4321,http://192.168.1.100:4321,https://auth.provider.com
      
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

## Authentication URL Configuration

### Multiple Access URLs

To allow access to Gitea Mirror through multiple URLs (e.g., local IP and public domain), you need to configure both server and client settings:

**Example Configuration:**
```bash
# Primary URL (required) - where the auth server is hosted
BETTER_AUTH_URL=https://gitea-mirror.mydomain.tld

# Client-side URL (optional) - tells the browser where to send auth requests
# Set this to your primary domain when accessing from different origins
PUBLIC_BETTER_AUTH_URL=https://gitea-mirror.mydomain.tld

# Additional trusted origins (optional) - origins allowed to make auth requests
BETTER_AUTH_TRUSTED_ORIGINS=http://10.10.20.45:4321,http://192.168.1.100:4321
```

This setup allows you to:
- Access via local network IP: `http://10.10.20.45:4321`
- Access via public domain: `https://gitea-mirror.mydomain.tld`
- Auth requests from the IP will be sent to the domain (via `PUBLIC_BETTER_AUTH_URL`)
- Each origin requires separate login due to browser cookie isolation

**Important:** When accessing from different origins (IP vs domain), you'll need to log in separately on each origin as cookies cannot be shared across different origins for security reasons.

### Trusted Origins

The `BETTER_AUTH_TRUSTED_ORIGINS` variable serves multiple purposes:

1. **SSO/OIDC Providers**: When using external authentication providers (Google, Authentik, Okta)
2. **Reverse Proxies**: When running behind nginx, Traefik, or other proxies
3. **Cross-Origin Requests**: When the frontend and backend are on different domains
4. **Development**: When testing from different URLs

**Example Scenarios:**
```bash
# For Authentik SSO integration
BETTER_AUTH_TRUSTED_ORIGINS=https://authentik.company.com,https://auth.company.com

# For reverse proxy setup
BETTER_AUTH_TRUSTED_ORIGINS=https://proxy.internal,https://public.domain.com

# For development with multiple environments
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000,http://192.168.1.100:3000
```

**Important Notes:**
- All URLs from `BETTER_AUTH_URL` are automatically trusted
- URLs must be complete with protocol (http/https)
- Multiple origins are separated by commas
- No trailing slashes needed

## Notes

1. **First Run**: Environment variables are loaded when the container starts. The configuration is applied after the first user account is created.

2. **UI Priority**: Manual changes made through the web UI will be preserved. Environment variables only set values for empty fields.

3. **Token Security**: All tokens are encrypted before being stored in the database.

4. **Auto-Enabling Features**: Certain environment variables automatically enable features when set:
   - `GITEA_MIRROR_INTERVAL` - Automatically enables scheduled mirroring
   - `CLEANUP_DELETE_IF_NOT_IN_GITHUB=true` - Automatically enables repository cleanup
   - `SCHEDULE_INTERVAL` or `DELAY` - Automatically enables the scheduler

5. **Backward Compatibility**: The `DELAY` variable is maintained for backward compatibility but `SCHEDULE_INTERVAL` is preferred.

6. **Required Scopes**: The GitHub token requires the following scopes:
   - `repo` (full control of private repositories)
   - `admin:org` (read organization data)
   - Additional scopes may be required for specific features

For more examples and detailed configuration, see the `.env.example` file in the repository.
