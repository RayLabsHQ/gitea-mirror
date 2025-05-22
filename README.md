<p align="center">
  <img src=".github/assets/logo.png" alt="Gitea Mirror Logo" width="120" />
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
docker compose --profile production up -d

# Using Bun
bun run setup && bun run dev

# Using LXC Containers
# For Proxmox VE (online)
curl -fsSL https://raw.githubusercontent.com/arunavo4/gitea-mirror/main/scripts/gitea-mirror-lxc-proxmox.sh | bash

# For local testing (offline-friendly)
sudo LOCAL_REPO_DIR=~/Development/gitea-mirror ./scripts/gitea-mirror-lxc-local.sh
````

See the [LXC Container Deployment Guide](scripts/README-lxc.md).

<p align="center">
  <img src=".github/assets/dashboard.png" alt="Dashboard" width="80%"/>
</p>

## ✨ Features

- 🔁 Sync public, private, or starred GitHub repos to Gitea
- 🏢 Mirror entire organizations with structure preservation
- 🐞 Optional mirroring of issues and labels
- 🌟 Mirror your starred repositories
- 🕹️ Modern user interface with toast notifications and smooth experience
- 🧠 Smart filtering and job queue with detailed logs
- ⚡ Concurrency queue processes multiple repositories in parallel
- 🛠️ Works with personal access tokens (GitHub + Gitea)
- 🔒 First-time user signup experience with secure authentication
- 🐳 Fully Dockerized + can be self-hosted in minutes
- 📊 Dashboard with real-time status updates
- ⏱️ Scheduled automatic mirroring

## 📸 Screenshots

<p align="center">
  <img src=".github/assets/repositories.png" width="45%"/>
  <img src=".github/assets/organisations.png" width="45%"/>
</p>
<p align="center">
  <img src=".github/assets/configuration.png" width="45%"/>
  <img src=".github/assets/activity.png" width="45%"/>
</p>

### Dashboard
The dashboard provides an overview of your mirroring status, including total repositories, successfully mirrored repositories, and recent activity.

### Repository Management
Manage all your repositories in one place. Filter by status, search by name, and trigger manual mirroring operations.

### Configuration
Easily configure your GitHub and Gitea connections, set up automatic mirroring schedules, and manage organization mirroring.

## Getting Started

See the [Quick Start Guide](docs/quickstart.md) for detailed instructions on getting up and running quickly.

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
docker compose --profile production up -d

# For development mode (requires configuration)
# Ensure you have run bun run setup first
docker compose -f docker-compose.dev.yml up -d
```


> [!IMPORTANT]
> **Docker Compose is the recommended method for running Gitea Mirror** as it provides a consistent environment with proper volume management for the SQLite database.


> [!NOTE]
> The examples above use the modern `docker compose` syntax (without hyphen) which is the recommended approach for Docker Compose V2. If you're using an older version of Docker Compose (V1), you may need to use `docker-compose` (with hyphen) instead.

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
docker compose --profile production up -d
```

See [Docker build documentation](./scripts/README-docker.md) for more details.

##### Using LXC Containers

Gitea Mirror offers two deployment options for LXC containers:

**1. Proxmox VE (online, recommended for production)**

```bash
# One-command installation on Proxmox VE
# Optional env overrides: CTID HOSTNAME STORAGE DISK_SIZE CORES MEMORY BRIDGE IP_CONF
curl -fsSL https://raw.githubusercontent.com/arunavo4/gitea-mirror/main/scripts/gitea-mirror-lxc-proxmox.sh | bash
```

**2. Local testing (offline-friendly, works on developer laptops)**

```bash
# Download the script
curl -fsSL https://raw.githubusercontent.com/arunavo4/gitea-mirror/main/scripts/gitea-mirror-lxc-local.sh -o gitea-mirror-lxc-local.sh
chmod +x gitea-mirror-lxc-local.sh

# Run with your local repo directory
sudo LOCAL_REPO_DIR=~/Development/gitea-mirror ./gitea-mirror-lxc-local.sh
```

Both scripts:
- Set up a privileged Ubuntu 22.04 LXC container
- Install Bun runtime environment
- Build the application
- Configure a systemd service
- Start the service automatically

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
- `JWT_SECRET`: Secret key for JWT token generation (important for security)


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

### Configuration

Gitea Mirror can be configured through environment variables or through the web UI. See the [Configuration Guide](docs/configuration.md) for more details.

Key configuration options include:

- GitHub connection settings (username, token, repository filters)
- Gitea connection settings (URL, token, organization)
- Mirroring options (issues, starred repositories, organizations)
- Scheduling options for automatic mirroring

> [!IMPORTANT]
> **SQLite is the only database required for Gitea Mirror**, handling both data storage and real-time event notifications.

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
  -e GITEA__database__PATH=/data/gitea.db \
  -e GITEA__server__DOMAIN=localhost \
  -e GITEA__server__ROOT_URL=http://localhost:3001/ \
  -e GITEA__server__SSH_DOMAIN=localhost \
  -e GITEA__server__SSH_PORT=2222 \
  -e GITEA__server__START_SSH_SERVER=true \
  -e GITEA__security__INSTALL_LOCK=true \
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
> For homelab/self-hosted setups, you can use the provided Docker Compose file with automatic event cleanup:
>
> ```bash
> # Clone the repository
> git clone https://github.com/arunavo4/gitea-mirror.git
> cd gitea-mirror
>
> # Start the application with Docker Compose
> docker-compose -f docker-compose.homelab.yml up -d
> ```
>
> This setup includes a cron job that runs daily to clean up old events and prevent the database from growing too large.


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
>
> # Clean up old events (keeps last 7 days by default)
> bun run cleanup-events
>
> # Clean up old events with custom retention period (e.g., 30 days)
> bun run cleanup-events 30
> ```
>
> For automated maintenance, consider setting up a cron job to run the cleanup script periodically:
>
> ```bash
> # Add this to your crontab (runs daily at 2 AM)
> 0 2 * * * cd /path/to/gitea-mirror && bun run cleanup-events
> ```


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
