---
title: "Configuration"
description: "Guide to configuring Gitea Mirror for your environment."
order: 2
updatedDate: 2023-10-15
---

<div class="mb-6">
  <h1 class="text-2xl font-bold text-foreground">Gitea Mirror Configuration Guide</h1>
  <p class="text-muted-foreground mt-2">This guide provides detailed information on how to configure Gitea Mirror for your environment.</p>
</div>

## Configuration Methods

Gitea Mirror can be configured using:

1. <span class="font-semibold text-foreground">Environment Variables</span>: Set configuration options through environment variables
2. <span class="font-semibold text-foreground">Web UI</span>: Configure the application through the web interface after installation

## Environment Variables

The following environment variables can be used to configure Gitea Mirror:

| Variable | Description | Default Value | Example |
|----------|-------------|---------------|---------|
| `NODE_ENV` | Runtime environment (development, production, test) | `development` | `production` |
| `DATABASE_URL` | SQLite database URL | `sqlite://data/gitea-mirror.db` | `sqlite://path/to/your/database.db` |
| `JWT_SECRET` | Secret key for JWT authentication | `your-secret-key-change-this-in-production` | `your-secure-random-string` |
| `HOST` | Server host | `localhost` | `0.0.0.0` |
| `PORT` | Server port | `3000` | `8080` |

### Important Security Note

In production environments, you should always set a strong, unique `JWT_SECRET` to ensure secure authentication.

## Web UI Configuration

After installing and starting Gitea Mirror, you can configure it through the web interface:

1. Navigate to `http://your-server:port/`
2. If this is your first time, you'll be guided through creating an admin account
3. Log in with your credentials
4. Go to the Configuration page

### GitHub Configuration

The GitHub configuration section allows you to connect to GitHub and specify which repositories to mirror.

| Option | Description | Default |
|--------|-------------|---------|
| Username | Your GitHub username | - |
| Token | GitHub personal access token | - |
| Skip Forks | Skip forked repositories | `false` |
| Private Repositories | Include private repositories | `false` |
| Mirror Issues | Mirror issues from GitHub to Gitea | `false` |
| Mirror Starred | Mirror starred repositories | `false` |
| Mirror Organizations | Mirror organization repositories | `false` |
| Only Mirror Orgs | Only mirror organization repositories | `false` |
| Preserve Org Structure | Maintain organization structure in Gitea | `false` |
| Skip Starred Issues | Skip mirroring issues for starred repositories | `false` |

#### GitHub Token Permissions

Your GitHub token needs the following permissions:

- `repo` - Full control of private repositories
- `read:org` - Read organization membership
- `read:user` - Read user profile data

To create a GitHub token:

1. Go to [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
2. Click "Generate new token"
3. Select the required permissions
4. Copy the generated token and paste it into Gitea Mirror

### Gitea Configuration

The Gitea configuration section allows you to connect to your Gitea instance and specify how repositories should be mirrored.

| Option | Description | Default |
|--------|-------------|---------|
| URL | Gitea server URL | - |
| Token | Gitea access token | - |
| Organization | Default organization for mirrored repositories | - |
| Visibility | Default visibility for mirrored repositories | `public` |
| Starred Repos Org | Organization for starred repositories | `github` |

#### Gitea Token Creation

To create a Gitea access token:

1. Log in to your Gitea instance
2. Go to Settings > Applications
3. Under "Generate New Token", enter a name for your token
4. Click "Generate Token"
5. Copy the generated token and paste it into Gitea Mirror

### Schedule Configuration

You can configure automatic mirroring on a schedule:

| Option | Description | Default |
|--------|-------------|---------|
| Enable Scheduling | Enable automatic mirroring | `false` |
| Interval (seconds) | Time between mirroring operations | `3600` (1 hour) |

## Advanced Configuration

### Repository Filtering

You can include or exclude specific repositories using patterns:

- Include patterns: Only repositories matching these patterns will be mirrored
- Exclude patterns: Repositories matching these patterns will be skipped

Example patterns:
- `*` - All repositories
- `org-name/*` - All repositories in a specific organization
- `username/repo-name` - A specific repository
