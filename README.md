<p align="center">
  <img src=".github/assets/logo-no-bg.png" alt="Gitea Mirror Logo" width="120" />
  <h1>Gitea Mirror</h1>
  <p><i>A modern web app for automatically mirroring repositories from GitHub to your self-hosted Gitea.</i></p>
  <p align="center">
    <a href="https://github.com/arunavo4/gitea-mirror/releases/latest"><img src="https://img.shields.io/github/v/tag/arunavo4/gitea-mirror?label=release" alt="release"/></a>
    <a href="https://github.com/arunavo4/gitea-mirror/actions/workflows/astro-build-test.yml"><img src="https://img.shields.io/github/actions/workflow/status/arunavo4/gitea-mirror/astro-build-test.yml?branch=main" alt="build"/></a>
    <a href="https://github.com/arunavo4/gitea-mirror/pkgs/container/gitea-mirror"><img src="https://img.shields.io/badge/ghcr.io-container-blue?logo=github" alt="container"/></a>
    <a href="https://github.com/arunavo4/gitea-mirror/blob/main/LICENSE"><img src="https://img.shields.io/github/license/arunavo4/gitea-mirror" alt="license"/></a>
  </p>
</p>

## 🚀 Quick Start

```bash
# Using Docker (recommended)
docker compose up -d

# Using Bun
bun run setup && bun run dev

# Using LXC Containers
# For Proxmox VE (online) - Community script by Tobias ([CrazyWolf13](https://github.com/CrazyWolf13))
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/gitea-mirror.sh)"

# For local testing (offline-friendly)
sudo LOCAL_REPO_DIR=~/Development/gitea-mirror ./scripts/gitea-mirror-lxc-local.sh
````

See the [LXC Container Deployment Guide](scripts/README-lxc.md).

<p align="center">
  <img src=".github/assets/dashboard.png" alt="Dashboard" width="full"/>
</p>

## ✨ Features

- 🔁 Sync public, private, or starred GitHub repos to Gitea
- 🏢 Mirror entire organizations with flexible organization strategies
- 🎯 Custom destination control for both organizations and individual repositories
- 🐞 Optional mirroring of issues and labels
- 🌟 Mirror your starred repositories to a dedicated organization
- 🕹️ Modern user interface with toast notifications and smooth experience
- 🧠 Smart filtering and job queue with detailed logs
- 🛠️ Works with personal access tokens (GitHub + Gitea)
- 🔒 First-time user signup experience with secure authentication
- 🐳 Fully Dockerized + can be self-hosted in minutes
- 📊 Dashboard with real-time status updates
- ⏱️ Scheduled automatic mirroring

## 📸 Screenshots

<p align="center">
  <img src=".github/assets/repositories.png" width="49%"/>
  <img src=".github/assets/organisations.png" width="49%"/>
</p>
<p align="center">
  <img src=".github/assets/configuration.png" width="49%"/>
  <img src=".github/assets/activity.png" width="49%"/>
</p>

### Dashboard
The dashboard provides an overview of your mirroring status, including total repositories, successfully mirrored repositories, and recent activity.

### Repository Management
Manage all your repositories in one place. Filter by status, search by name, and trigger manual mirroring operations.

### Configuration
Easily configure your GitHub and Gitea connections, set up automatic mirroring schedules, and manage organization mirroring.

## Getting Started

See the [Quick Start Guide](src/content/docs/quickstart.md) for detailed instructions on getting up and running quickly.

### Prerequisites

- Bun 1.2.9 or later
- A GitHub account with a personal access token
- A Gitea instance with an access token


#### Database

The database (`data/gitea-mirror.db`) is created when the application first runs. It starts empty and is populated as you configure and use the application.


> [!NOTE]
> On first launch, you'll be guided through creating an admin account with your chosen credentials.

#### Production Database

The production database (`data/gitea-mirror.db`) is created when the application runs in production mode. It starts empty and is populated as you configure and use the application.


> [!IMPORTANT]
> The production database file is excluded from the Git repository as it may contain sensitive information like GitHub and Gitea tokens. **Never commit this file to the repository.**

##### Database Initialization

Before running the application in production mode for the first time, you need to initialize the database:

```bash
# Initialize the database for production mode
bun run setup
```

This will create the necessary tables. On first launch, you'll be guided through creating your admin account with a secure password.

### Installation

#### Using Docker (Recommended)

Gitea Mirror provides multi-architecture Docker images that work on both ARM64 (e.g., Apple Silicon, Raspberry Pi) and x86_64 (Intel/AMD) platforms.

##### Using Docker Compose (Recommended)

```bash
# Start the application using Docker Compose
docker compose up -d

# For development mode (requires configuration)
# Ensure you have run bun run setup first
docker compose -f docker-compose.dev.yml up -d
```


> [!IMPORTANT]
> **Docker Compose is the recommended method for running Gitea Mirror** as it provides a consistent environment with proper volume management for the SQLite database.


> [!NOTE]
> The examples above use the modern `docker compose` syntax (without hyphen) which is the recommended approach for Docker Compose V2. If you're using an older version of Docker Compose (V1), you may need to use `docker-compose` (with hyphen) instead.

##### Self-Signed Certificates and Custom CAs

If your Gitea instance uses a self-signed certificate or a certificate from a custom CA, you'll need to configure the container to trust it. Due to a [known issue with Node.js fetch](https://github.com/nodejs/node/issues/51426), the `NODE_EXTRA_CA_CERTS` environment variable doesn't work properly.

**Recommended Solution: Mount your CA certificate**

1. Create a directory for your CA certificates:
   ```bash
   mkdir ca-certificates
   ```

2. Copy your CA certificate to this directory:
   ```bash
   cp /path/to/your-ca.crt ca-certificates/
   ```

3. Update your `docker-compose.yml` to mount the certificate:
   ```yaml
   volumes:
     - gitea-mirror-data:/app/data
     - ./ca-certificates/your-ca.crt:/usr/local/share/ca-certificates/your-ca.crt:ro
   ```

4. Restart the container:
   ```bash
   docker compose restart
   ```

**Development/Testing Workaround**

For development environments only, you can disable certificate validation:
```yaml
environment:
  - NODE_TLS_REJECT_UNAUTHORIZED=0
```

> [!WARNING]
> Never use `NODE_TLS_REJECT_UNAUTHORIZED=0` in production as it disables all SSL/TLS certificate validation, making your connection vulnerable to man-in-the-middle attacks.

##### Using Pre-built Images from GitHub Container Registry

If you want to run the container directly without Docker Compose:

```bash
# Pull the latest multi-architecture image
docker pull ghcr.io/arunavo4/gitea-mirror:latest

# Run the application with a volume for persistent data
docker run -d -p 4321:4321 \
  -v gitea-mirror-data:/app/data \
  ghcr.io/arunavo4/gitea-mirror:latest
```

##### Building Docker Images Manually

The project includes a build script to create and manage multi-architecture Docker images:

```bash
# Copy example environment file if you don't have one
cp .env.example .env

# Edit .env file with your preferred settings
# DOCKER_REGISTRY, DOCKER_IMAGE, DOCKER_TAG, etc.

# Build and load into local Docker
./scripts/build-docker.sh --load

# OR: Build and push to a registry (requires authentication)
./scripts/build-docker.sh --push

# Then run with Docker Compose
docker compose up -d
```

See [Docker build documentation](./scripts/README-docker.md) for more details.

##### Using LXC Containers (Proxmox VE)

For Proxmox VE users, Gitea Mirror can be deployed using the community-maintained script:

```bash
# One-command installation on Proxmox VE
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/gitea-mirror.sh)"
```

This community script:
- Creates a privileged Alpine Linux LXC container
- Installs Bun runtime environment
- Clones and builds Gitea Mirror
- Configures a systemd service for automatic startup
- Sets up the application to run on port 4321

> [!NOTE]
> The script is maintained by the [Community Scripts for Proxmox VE](https://community-scripts.github.io/ProxmoxVE/) project.
> For more information, visit the [Gitea Mirror script documentation](https://community-scripts.github.io/ProxmoxVE/scripts?id=gitea-mirror).

After installation, access Gitea Mirror at `http://<container-ip>:4321`

The application includes a health check endpoint at `/api/health` for monitoring.

See the [LXC Container Deployment Guide](scripts/README-lxc.md) for detailed instructions.

##### Building Your Own Image

For manual Docker builds (without the helper script):

```bash
# Build the Docker image for your current architecture
docker build -t gitea-mirror:latest .

# Build multi-architecture images (requires Docker Buildx)
docker buildx create --name multiarch --driver docker-container --use
docker buildx build --platform linux/amd64,linux/arm64 -t gitea-mirror:latest --load .

# If you encounter issues with Buildx, you can try these workarounds:
# 1. Retry with network settings
docker buildx build --platform linux/amd64,linux/arm64 -t gitea-mirror:latest --network=host --load .

# 2. Build one platform at a time if you're having resource issues
docker buildx build --platform linux/amd64 -t gitea-mirror:amd64 --load .
docker buildx build --platform linux/arm64 -t gitea-mirror:arm64 --load .

# Create a named volume for database persistence
docker volume create gitea-mirror-data
```

##### Environment Variables

The Docker container can be configured with the following environment variables:

- `DATABASE_URL`: SQLite database URL (default: `file:data/gitea-mirror.db`)
- `HOST`: Host to bind to (default: `0.0.0.0`)
- `PORT`: Port to listen on (default: `4321`)
- `JWT_SECRET`: Secret key for JWT token generation (auto-generated if not provided)

> [!TIP]
> For security, Gitea Mirror will automatically generate a secure random JWT secret on first run if one isn't provided or if the default value is used. This generated secret is stored in the data directory for persistence across container restarts.

#### Manual Installation

```bash
# Clone the repository
git clone https://github.com/arunavo4/gitea-mirror.git
cd gitea-mirror

# Quick setup (installs dependencies and initializes the database)
bun run setup

# Development Mode Options

# Run in development mode
bun run dev

# Run in development mode with clean database (removes existing DB first)
bun run dev:clean

# Production Mode Options

# Build the application
bun run build

# Preview the production build
bun run preview

# Start the production server (default)
bun run start

# Start the production server with a clean setup
bun run start:fresh

# Database Management

# Initialize the database
bun run init-db

# Reset users for testing first-time signup
bun run reset-users

# Check database status
bun run check-db
```

##### Database Permissions for Direct Installation

> [!IMPORTANT]
> **If you're running the application directly** (not using Docker), you may encounter SQLite permission errors. This is because SQLite requires both read/write access to the database file and write access to the directory containing the database.

**Common Error:**
```
Error: [ERROR] SQLiteError: attempt to write a readonly database
```

**Solution:**
```bash
# Ensure the data directory exists and has proper permissions
mkdir -p data
chmod 755 data

# If the database file already exists, ensure it's writable
chmod 644 data/gitea-mirror.db

# Make sure the user running the application owns the data directory
chown -R $(whoami) data/
```

**Why Docker doesn't have this issue:**
- Docker containers run with a dedicated user (`gitea-mirror`) that owns the `/app/data` directory
- The container setup ensures proper permissions are set during image build
- Volume mounts are handled by Docker with appropriate permissions

**Recommended approach:** Use Docker or Docker Compose for deployment to avoid permission issues entirely.

### Configuration

Gitea Mirror can be configured through environment variables or through the web UI. See the [Configuration Guide](src/content/docs/configuration.md) for more details.

Key configuration options include:

- GitHub connection settings (username, token, repository filters)
- Gitea connection settings (URL, token, organization)
- Mirroring options (issues, starred repositories, organizations)
- Scheduling options for automatic mirroring

> [!IMPORTANT]
> **SQLite is the only database required for Gitea Mirror**, handling both data storage and real-time event notifications.

### Mirror Strategies & Destination Customization

Gitea Mirror offers three flexible strategies for organizing your repositories in Gitea, with fine-grained control over destinations:

#### 1. **Preserve GitHub Structure** (Default)
- Personal repositories → Your Gitea username (or custom organization)
- Organization repositories → Same organization name in Gitea (with individual overrides)
- Maintains the exact structure from GitHub with optional customization

#### 2. **Single Organization**
- All repositories → One designated organization
- Simplifies management by consolidating everything
- Requires specifying a destination organization name

#### 3. **Flat User Structure**
- All repositories → Your Gitea user account
- No organizations needed
- Simplest approach for personal use

#### Destination Customization

**Organization-Level Overrides:**
- Click the edit button on any organization card to set a custom destination
- All repositories from that GitHub organization will be mirrored to your specified Gitea organization
- Visual indicators show when custom destinations are active

**Repository-Level Overrides:**
- Fine-tune individual repository destinations in the repository table
- Click the edit button in the "Destination" column to customize where a specific repo is mirrored
- Overrides organization-level settings for maximum flexibility
- Starred repositories display a ⭐ icon and always go to the configured starred repos organization

**Priority Hierarchy:**
1. Starred repositories → Always go to `starredReposOrg` (not editable)
2. Repository-level custom destination (highest priority for non-starred)
3. Organization-level custom destination
4. Personal repos override (for non-organization repos)
5. Default strategy rules (lowest priority)

> [!NOTE]
> **Starred Repositories**: Repositories you've starred on GitHub are automatically organized into a separate organization (default: "starred") and cannot have custom destinations. They're marked with a ⭐ icon for easy identification.

> [!TIP]
> **Example Use Cases**: 
> - Mirror personal repos to `personal-archive` organization
> - Redirect `work-org` repos to `company-mirror` in Gitea
> - Override a single important repo to go to a special organization
> - Keep `company-org` repos in their own `company-org` organization
> - Override `community-scripts` to go to `community-mirrors` organization
> - This gives you complete control while maintaining GitHub's structure as the default

## 🚀 Development

### Local Development Setup

```bash
# Install dependencies
bun run setup

# Start the development server
bun run dev
```


### Setting Up a Local Gitea Instance for Testing

For full end-to-end testing, you can set up a local Gitea instance using Docker:

```bash
# Create a Docker network for Gitea and Gitea Mirror to communicate
# Using the --label flag ensures proper Docker Compose compatibility
docker network create --label com.docker.compose.network=gitea-network gitea-network

# Create volumes for Gitea data persistence
docker volume create gitea-data
docker volume create gitea-config

# Run Gitea container
docker run -d \
  --name gitea \
  --network gitea-network \
  -p 3001:3000 \
  -p 2222:22 \
  -v gitea-data:/data \
  -v gitea-config:/etc/gitea \
  -e USER_UID=1000 \
  -e USER_GID=1000 \
  -e GITEA__database__DB_TYPE=sqlite3 \
  -e GITEA__database__PATH=/data/gitea/gitea.db \
  -e GITEA__server__DOMAIN=localhost \
  -e GITEA__server__ROOT_URL=http://localhost:3001/ \
  -e GITEA__server__SSH_DOMAIN=localhost \
  -e GITEA__server__SSH_PORT=2222 \
  -e GITEA__server__START_SSH_SERVER=true \
  -e GITEA__security__INSTALL_LOCK=false \
  -e GITEA__service__DISABLE_REGISTRATION=false \
  gitea/gitea:latest
```


> [!TIP]
> After Gitea is running:
> 1. Access Gitea at http://localhost:3001/
> 2. Register a new user
> 3. Create a personal access token in Gitea (Settings > Applications > Generate New Token)
> 4. Run Gitea Mirror with the local Gitea configuration:

```bash
# Run Gitea Mirror connected to the local Gitea instance
docker run -d \
  --name gitea-mirror-dev \
  --network gitea-network \
  -p 4321:4321 \
  -v gitea-mirror-data:/app/data \
  -e NODE_ENV=development \
  -e JWT_SECRET=dev-secret-key \
  -e GITHUB_TOKEN=your-github-token \
  -e GITHUB_USERNAME=your-github-username \
  -e GITEA_URL=http://gitea:3000 \
  -e GITEA_TOKEN=your-local-gitea-token \
  -e GITEA_USERNAME=your-local-gitea-username \
  arunavo4/gitea-mirror:latest
```

> [!NOTE]
> This setup allows you to test the full mirroring functionality with a local Gitea instance.

### Using Docker Compose for Development


For convenience, a dedicated development docker-compose file is provided that sets up both Gitea Mirror and a local Gitea instance:

```bash
# Start with development environment and local Gitea instance
docker compose -f docker-compose.dev.yml up -d
```


> [!TIP]
> You can also create a `.env` file with your GitHub and Gitea credentials:
>
> ```env
> # GitHub credentials
> GITHUB_TOKEN=your-github-token
> GITHUB_USERNAME=your-github-username
>
> # Gitea credentials (will be set up after you create a user in the local Gitea instance)
> GITEA_TOKEN=your-local-gitea-token
> GITEA_USERNAME=your-local-gitea-username
> ```

## Technologies Used

- **Frontend**: Astro, React, Shadcn UI, Tailwind CSS v4
- **Backend**: Bun
- **Database**: SQLite (handles both data storage and event notifications)
- **API Integration**: GitHub API (Octokit), Gitea API
- **Deployment Options**: Docker containers, LXC containers (Proxmox VE and local testing)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


## Troubleshooting

### Docker Compose Network Issues

> [!WARNING]
> If you encounter network-related warnings or errors when running Docker Compose, such as:
>
> ```
> WARN[0095] a network with name gitea-network exists but was not created by compose.
> Set `external: true` to use an existing network
> ```
>
> or
>
> ```
> network gitea-network was found but has incorrect label com.docker.compose.network set to "" (expected: "gitea-network")
> ```

Try the following steps:

1. Stop the current Docker Compose stack:
   ```bash
   docker compose -f docker-compose.dev.yml down
   ```

2. Remove the existing network:
   ```bash
   docker network rm gitea-network
   ```

3. Restart the Docker Compose stack:
   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```

> [!TIP]
> If you need to share the network with other Docker Compose projects, you can modify the `docker-compose.dev.yml` file to mark the network as external:
>
> ```yaml
> networks:
>   gitea-network:
>     name: gitea-network
>     external: true
> ```

### Database Persistence

> [!TIP]
> The application uses SQLite for all data storage and event notifications. Make sure the database file is properly mounted when using Docker:
>
> ```bash
> # Run with a volume for persistent data storage
> docker run -d -p 4321:4321 \
>   -v gitea-mirror-data:/app/data \
>   ghcr.io/arunavo4/gitea-mirror:latest
> ```
>
> For homelab/self-hosted setups, you can use the standard Docker Compose file which includes automatic database cleanup:
>
> ```bash
> # Clone the repository
> git clone https://github.com/arunavo4/gitea-mirror.git
> cd gitea-mirror
>
> # Start the application with Docker Compose
> docker compose up -d
> ```
>
> This setup provides a complete containerized deployment for the Gitea Mirror application.

#### Docker Volume Types and Permissions

> [!IMPORTANT]
> **Named Volumes vs Bind Mounts**: If you encounter SQLite permission errors even when using Docker, check your volume configuration:

**✅ Named Volumes (Recommended):**
```yaml
volumes:
  - gitea-mirror-data:/app/data  # Docker manages permissions automatically
```

**⚠️ Bind Mounts (Requires Manual Permission Setup):**
```yaml
volumes:
  - /host/path/to/data:/app/data  # Host filesystem permissions apply
```

**If using bind mounts**, ensure the host directory is owned by UID 1001 (the `gitea-mirror` user):
```bash
# Set correct ownership for bind mount
sudo chown -R 1001:1001 /host/path/to/data
sudo chmod -R 755 /host/path/to/data
```

**Why named volumes work better:**
- Docker automatically handles permissions
- Better portability across different hosts
- No manual permission setup required
- Used by our official docker-compose.yml


#### Database Maintenance

> [!TIP]
> For database maintenance, you can use the provided scripts:
>
> ```bash
> # Check database integrity
> bun run check-db
>
> # Fix database issues
> bun run fix-db
>
> # Reset user accounts (for development)
> bun run reset-users
> ```
>
> **Note:** For cleaning up old activities and events, use the cleanup button in the Activity Log page of the web interface.


> [!NOTE]
> This implementation provides:
> - Automatic retry with exponential backoff
> - Better error logging
> - Connection event handling
> - Proper timeout settings


### Container Health Checks

> [!TIP]
> If containers are not starting properly, check their health status:
>
> ```bash
> docker ps --format "{{.Names}}: {{.Status}}"
> ```
>
> For more detailed logs:
>
> ```bash
> docker logs gitea-mirror-dev
> ```

## Acknowledgements

- [Octokit](https://github.com/octokit/rest.js/) - GitHub REST API client for JavaScript
- [Shadcn UI](https://ui.shadcn.com/) - For the beautiful UI components
- [Astro](https://astro.build/) - For the excellent web framework
- [Community Scripts](https://community-scripts.github.io/ProxmoxVE/) - For the Proxmox VE installation script maintained by [CrazyWolf13](https://github.com/CrazyWolf13)
