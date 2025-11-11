# Nix Deployment Guide

This guide covers deploying Gitea Mirror using Nix flakes. The Nix deployment follows the same minimal configuration philosophy as `docker-compose.alt.yml` - secrets are auto-generated, and everything else can be configured via the web UI.

## Prerequisites

- Nix 2.4+ installed
- For NixOS module: NixOS 23.05+

### Enable Flakes (Recommended)

To enable flakes permanently and avoid typing flags, add to `/etc/nix/nix.conf` or `~/.config/nix/nix.conf`:
```
experimental-features = nix-command flakes
```

**Note:** If you don't enable flakes globally, add `--extra-experimental-features 'nix-command flakes'` to all nix commands shown below.

## Quick Start (Zero Configuration!)

### Run Immediately - No Setup Required

```bash
# Run directly from the flake (local)
nix run --extra-experimental-features 'nix-command flakes' .#gitea-mirror

# Or from GitHub (once published)
nix run --extra-experimental-features 'nix-command flakes' github:RayLabsHQ/gitea-mirror

# If you have flakes enabled globally, simply:
nix run .#gitea-mirror
```

That's it! On first run:
- Secrets (`BETTER_AUTH_SECRET` and `ENCRYPTION_SECRET`) are auto-generated
- Database is automatically created and initialized
- Startup recovery and repair scripts run automatically
- Access the web UI at http://localhost:4321

Everything else (GitHub credentials, Gitea settings, mirror options) is configured through the web interface after signup.

### Development Environment

```bash
# Enter development shell with all dependencies
nix develop --extra-experimental-features 'nix-command flakes'

# Or use direnv for automatic environment loading (handles flags automatically)
echo "use flake" > .envrc
direnv allow
```

### Build and Install

```bash
# Build the package
nix build --extra-experimental-features 'nix-command flakes'

# Run the built package
./result/bin/gitea-mirror

# Install to your profile
nix profile install --extra-experimental-features 'nix-command flakes' .#gitea-mirror
```

## What Happens on First Run?

Following the same pattern as the Docker deployment, the Nix package automatically:

1. **Creates data directory**: `~/.local/share/gitea-mirror` (or `$DATA_DIR`)
2. **Generates secrets** (stored securely in data directory):
   - `BETTER_AUTH_SECRET` - Session authentication (32-char hex)
   - `ENCRYPTION_SECRET` - Token encryption (48-char base64)
3. **Initializes database**: SQLite database with Drizzle migrations
4. **Runs startup scripts**:
   - Environment configuration loader
   - Crash recovery for interrupted jobs
   - Repository status repair
5. **Starts the application** with graceful shutdown handling

## NixOS Module - Minimal Deployment

### Simplest Possible Configuration

Add to your NixOS configuration (`/etc/nixos/configuration.nix`):

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    gitea-mirror.url = "github:RayLabsHQ/gitea-mirror";
  };

  outputs = { nixpkgs, gitea-mirror, ... }: {
    nixosConfigurations.your-hostname = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        gitea-mirror.nixosModules.default
        {
          # That's it! Just enable the service
          services.gitea-mirror.enable = true;
        }
      ];
    };
  };
}
```

Apply with:
```bash
sudo nixos-rebuild switch
```

Access at http://localhost:4321, sign up (first user is admin), and configure everything via the web UI.

### Production Configuration

For production with custom domain and firewall:

```nix
{
  services.gitea-mirror = {
    enable = true;
    host = "0.0.0.0";
    port = 4321;
    betterAuthUrl = "https://mirror.example.com";
    betterAuthTrustedOrigins = "https://mirror.example.com";
    openFirewall = true;
  };

  # Optional: Use with nginx reverse proxy
  services.nginx = {
    enable = true;
    virtualHosts."mirror.example.com" = {
      locations."/" = {
        proxyPass = "http://127.0.0.1:4321";
        proxyWebsockets = true;
      };
      enableACME = true;
      forceSSL = true;
    };
  };
}
```

### Advanced: Manual Secret Management

If you prefer to manage secrets manually (e.g., with sops-nix or agenix):

1. Create a secrets file:
```bash
# /var/lib/gitea-mirror/secrets.env
BETTER_AUTH_SECRET=your-32-character-minimum-secret-key-here
ENCRYPTION_SECRET=your-encryption-secret-here
```

2. Reference it in your configuration:
```nix
{
  services.gitea-mirror = {
    enable = true;
    environmentFile = "/var/lib/gitea-mirror/secrets.env";
  };
}
```

### Full Configuration Options

```nix
{
  services.gitea-mirror = {
    enable = true;
    package = gitea-mirror.packages.x86_64-linux.default;  # Override package
    dataDir = "/var/lib/gitea-mirror";
    user = "gitea-mirror";
    group = "gitea-mirror";
    host = "0.0.0.0";
    port = 4321;
    betterAuthUrl = "https://mirror.example.com";
    betterAuthTrustedOrigins = "https://mirror.example.com";

    # Concurrency controls (match docker-compose.alt.yml)
    mirrorIssueConcurrency = 3;  # Set to 1 for perfect chronological order
    mirrorPullRequestConcurrency = 5;  # Set to 1 for perfect chronological order

    environmentFile = null;  # Optional secrets file
    openFirewall = true;
  };
}
```

## Service Management (NixOS)

```bash
# Start the service
sudo systemctl start gitea-mirror

# Stop the service
sudo systemctl stop gitea-mirror

# Restart the service
sudo systemctl restart gitea-mirror

# Check status
sudo systemctl status gitea-mirror

# View logs
sudo journalctl -u gitea-mirror -f

# Health check
curl http://localhost:4321/api/health
```

## Environment Variables

All variables from `docker-compose.alt.yml` are supported:

```bash
# === AUTO-GENERATED (Don't set unless you want specific values) ===
BETTER_AUTH_SECRET          # Auto-generated, stored in data dir
ENCRYPTION_SECRET           # Auto-generated, stored in data dir

# === CORE SETTINGS (Have good defaults) ===
DATA_DIR="$HOME/.local/share/gitea-mirror"
DATABASE_URL="file:$DATA_DIR/gitea-mirror.db"
HOST="0.0.0.0"
PORT="4321"
NODE_ENV="production"

# === BETTER AUTH (Override for custom domains) ===
BETTER_AUTH_URL="http://localhost:4321"
BETTER_AUTH_TRUSTED_ORIGINS="http://localhost:4321"
PUBLIC_BETTER_AUTH_URL="http://localhost:4321"

# === CONCURRENCY CONTROLS ===
MIRROR_ISSUE_CONCURRENCY=3           # Default: 3 (set to 1 for perfect order)
MIRROR_PULL_REQUEST_CONCURRENCY=5    # Default: 5 (set to 1 for perfect order)

# === CONFIGURE VIA WEB UI (Not needed at startup) ===
# GitHub credentials, Gitea settings, mirror options, scheduling, etc.
# All configured after signup through the web interface
```

## Database Management

The Nix package includes a database management helper:

```bash
# Initialize database (done automatically on first run)
gitea-mirror-db init

# Check database health
gitea-mirror-db check

# Fix database issues
gitea-mirror-db fix

# Reset users
gitea-mirror-db reset-users
```

## Home Manager Integration

For single-user deployments:

```nix
{ config, pkgs, ... }:
let
  gitea-mirror = (import (fetchTarball "https://github.com/RayLabsHQ/gitea-mirror/archive/main.tar.gz")).packages.${pkgs.system}.default;
in {
  home.packages = [ gitea-mirror ];

  # Optional: Run as user service
  systemd.user.services.gitea-mirror = {
    Unit = {
      Description = "Gitea Mirror Service";
      After = [ "network.target" ];
    };

    Service = {
      Type = "simple";
      ExecStart = "${gitea-mirror}/bin/gitea-mirror";
      Restart = "always";
      Environment = [
        "DATA_DIR=%h/.local/share/gitea-mirror"
        "HOST=127.0.0.1"
        "PORT=4321"
      ];
    };

    Install = {
      WantedBy = [ "default.target" ];
    };
  };
}
```

## Docker Image from Nix (Optional)

You can also use Nix to create a Docker image:

```nix
# Add to flake.nix packages section
dockerImage = pkgs.dockerTools.buildLayeredImage {
  name = "gitea-mirror";
  tag = "latest";
  contents = [ self.packages.${system}.default pkgs.cacert pkgs.openssl ];
  config = {
    Cmd = [ "${self.packages.${system}.default}/bin/gitea-mirror" ];
    ExposedPorts = { "4321/tcp" = {}; };
    Env = [
      "DATA_DIR=/data"
      "DATABASE_URL=file:/data/gitea-mirror.db"
    ];
    Volumes = { "/data" = {}; };
  };
};
```

Build and load:
```bash
nix build --extra-experimental-features 'nix-command flakes' .#dockerImage
docker load < result
docker run -p 4321:4321 -v gitea-mirror-data:/data gitea-mirror:latest
```

## Comparison: Docker vs Nix

Both deployment methods follow the same philosophy:

| Feature | Docker Compose | Nix |
|---------|---------------|-----|
| **Configuration** | Minimal (only BETTER_AUTH_SECRET) | Zero config (auto-generated) |
| **Secret Generation** | Auto-generated & persisted | Auto-generated & persisted |
| **Database Init** | Automatic on first run | Automatic on first run |
| **Startup Scripts** | Runs recovery/repair/env-config | Runs recovery/repair/env-config |
| **Graceful Shutdown** | Signal handling in entrypoint | Signal handling in wrapper |
| **Health Check** | Docker healthcheck | systemd timer (optional) |
| **Updates** | `docker pull` | `nix flake update && nixos-rebuild` |

## Troubleshooting

### Check Auto-Generated Secrets
```bash
# For standalone
cat ~/.local/share/gitea-mirror/.better_auth_secret
cat ~/.local/share/gitea-mirror/.encryption_secret

# For NixOS service
sudo cat /var/lib/gitea-mirror/.better_auth_secret
sudo cat /var/lib/gitea-mirror/.encryption_secret
```

### Database Issues
```bash
# Check if database exists
ls -la ~/.local/share/gitea-mirror/gitea-mirror.db

# Reinitialize (deletes all data!)
rm ~/.local/share/gitea-mirror/gitea-mirror.db
gitea-mirror-db init
```

### Permission Issues (NixOS)
```bash
sudo chown -R gitea-mirror:gitea-mirror /var/lib/gitea-mirror
sudo chmod 700 /var/lib/gitea-mirror
```

### Port Already in Use
```bash
# Change port
export PORT=8080
gitea-mirror

# Or in NixOS config
services.gitea-mirror.port = 8080;
```

### View Startup Logs
```bash
# Standalone (verbose output on console)
gitea-mirror

# NixOS service
sudo journalctl -u gitea-mirror -f --since "5 minutes ago"
```

## Updating

### Standalone Installation
```bash
# Update flake lock
nix flake update --extra-experimental-features 'nix-command flakes'

# Rebuild
nix build --extra-experimental-features 'nix-command flakes'

# Or update profile
nix profile upgrade --extra-experimental-features 'nix-command flakes' gitea-mirror
```

### NixOS
```bash
# Update input
sudo nix flake lock --update-input gitea-mirror --extra-experimental-features 'nix-command flakes'

# Rebuild system
sudo nixos-rebuild switch --flake .#your-hostname
```

## Migration from Docker

To migrate from Docker to Nix while keeping your data:

1. **Stop Docker container:**
   ```bash
   docker-compose -f docker-compose.alt.yml down
   ```

2. **Copy data directory:**
   ```bash
   # For standalone
   cp -r ./data ~/.local/share/gitea-mirror

   # For NixOS
   sudo cp -r ./data /var/lib/gitea-mirror
   sudo chown -R gitea-mirror:gitea-mirror /var/lib/gitea-mirror
   ```

3. **Copy secrets (if you want to keep them):**
   ```bash
   # Extract from Docker volume
   docker run --rm -v gitea-mirror_data:/data alpine \
     cat /data/.better_auth_secret > better_auth_secret
   docker run --rm -v gitea-mirror_data:/data alpine \
     cat /data/.encryption_secret > encryption_secret

   # Copy to new location
   cp better_auth_secret ~/.local/share/gitea-mirror/.better_auth_secret
   cp encryption_secret ~/.local/share/gitea-mirror/.encryption_secret
   chmod 600 ~/.local/share/gitea-mirror/.*_secret
   ```

4. **Start Nix version:**
   ```bash
   gitea-mirror
   ```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
name: Build with Nix

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: cachix/install-nix-action@v24
      with:
        extra_nix_config: |
          experimental-features = nix-command flakes
    - uses: cachix/cachix-action@v12
      with:
        name: gitea-mirror
        authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}'
    - run: nix build
    - run: nix flake check
    # Note: GitHub Actions runner usually has flakes enabled by install-nix-action
```

## Resources

- [Nix Manual](https://nixos.org/manual/nix/stable/)
- [NixOS Options Search](https://search.nixos.org/options)
- [Nix Pills Tutorial](https://nixos.org/guides/nix-pills/)
- [Project Documentation](../README.md)
- [Docker Deployment](../docker-compose.alt.yml) - Equivalent minimal config
