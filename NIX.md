# Nix Deployment Quick Reference

## TL;DR

```bash
# Just run it - zero configuration needed!
nix run .#gitea-mirror
```

Secrets auto-generate, database auto-initializes, and the web UI starts at http://localhost:4321.

---

## Installation Options

### 1. Run Without Installing
```bash
nix run .#gitea-mirror
```

### 2. Install to Profile
```bash
nix profile install .#gitea-mirror
gitea-mirror
```

### 3. NixOS System Service
```nix
# configuration.nix
{
  inputs.gitea-mirror.url = "github:RayLabsHQ/gitea-mirror";

  services.gitea-mirror = {
    enable = true;
    betterAuthUrl = "https://mirror.example.com";  # For production
    openFirewall = true;
  };
}
```

### 4. Development
```bash
nix develop
# or
direnv allow
```

---

## What Gets Auto-Generated?

On first run, the wrapper automatically:

1. Creates `~/.local/share/gitea-mirror/` (or `$DATA_DIR`)
2. Generates `BETTER_AUTH_SECRET` → `.better_auth_secret`
3. Generates `ENCRYPTION_SECRET` → `.encryption_secret`
4. Initializes SQLite database
5. Runs startup recovery and repair scripts
6. Starts the application

---

## Key Commands

```bash
# Database management
gitea-mirror-db init      # Initialize database
gitea-mirror-db check     # Health check
gitea-mirror-db fix       # Fix issues

# Development
nix develop               # Enter dev shell
nix build                 # Build package
nix flake check           # Validate flake
```

---

## Environment Variables

All vars from `docker-compose.alt.yml` are supported:

```bash
DATA_DIR="$HOME/.local/share/gitea-mirror"
PORT=4321
HOST="0.0.0.0"
BETTER_AUTH_URL="http://localhost:4321"

# Secrets (auto-generated if not set)
BETTER_AUTH_SECRET=auto-generated
ENCRYPTION_SECRET=auto-generated

# Concurrency (for perfect ordering, set both to 1)
MIRROR_ISSUE_CONCURRENCY=3
MIRROR_PULL_REQUEST_CONCURRENCY=5
```

---

## NixOS Module Options

```nix
services.gitea-mirror = {
  enable = true;
  package = ...;                        # Override package
  dataDir = "/var/lib/gitea-mirror";   # Data location
  user = "gitea-mirror";               # Service user
  group = "gitea-mirror";              # Service group
  host = "0.0.0.0";                    # Bind address
  port = 4321;                         # Listen port
  betterAuthUrl = "http://...";        # External URL
  betterAuthTrustedOrigins = "...";    # CORS origins
  mirrorIssueConcurrency = 3;          # Concurrency
  mirrorPullRequestConcurrency = 5;    # Concurrency
  environmentFile = null;              # Optional secrets file
  openFirewall = true;                 # Open firewall
};
```

---

## Comparison: Docker vs Nix

| Feature | Docker | Nix |
|---------|--------|-----|
| **Config Required** | BETTER_AUTH_SECRET | None (auto-generated) |
| **Startup** | `docker-compose up` | `nix run .#gitea-mirror` |
| **Service** | Docker daemon | systemd (NixOS) |
| **Updates** | `docker pull` | `nix flake update` |
| **Reproducible** | Image-based | Hash-based |

---

## Full Documentation

See [docs/NIX_DEPLOYMENT.md](docs/NIX_DEPLOYMENT.md) for:
- Complete NixOS module configuration
- Home Manager integration
- Production deployment examples
- Migration from Docker
- Troubleshooting guide

---

## Key Features

- **Zero-config deployment** - Runs immediately without setup
- **Auto-secret generation** - Secure secrets created and persisted
- **Startup recovery** - Handles interrupted jobs automatically
- **Graceful shutdown** - Proper signal handling
- **Health checks** - Built-in monitoring support
- **Security hardening** - NixOS module includes systemd protections
- **Docker parity** - Same behavior as `docker-compose.alt.yml`
