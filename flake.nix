{
  description = "Gitea Mirror - Self-hosted GitHub to Gitea mirroring service";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Build the application
        gitea-mirror = pkgs.stdenv.mkDerivation {
          pname = "gitea-mirror";
          version = "3.8.11";

          src = ./.;

          nativeBuildInputs = with pkgs; [
            bun
          ];

          buildInputs = with pkgs; [
            sqlite
            openssl
          ];

          configurePhase = ''
            export HOME=$TMPDIR
            export BUN_INSTALL=$TMPDIR/.bun
            export PATH=$BUN_INSTALL/bin:$PATH
          '';

          buildPhase = ''
            # Install dependencies
            bun install --frozen-lockfile --no-progress

            # Build the application
            bun run build
          '';

          installPhase = ''
            mkdir -p $out/lib/gitea-mirror
            mkdir -p $out/bin

            # Copy the built application
            cp -r dist $out/lib/gitea-mirror/
            cp -r node_modules $out/lib/gitea-mirror/
            cp -r scripts $out/lib/gitea-mirror/
            cp package.json $out/lib/gitea-mirror/

            # Create entrypoint script that matches Docker behavior
            cat > $out/bin/gitea-mirror <<'EOF'
#!/usr/bin/env bash
set -e

# === DEFAULT CONFIGURATION ===
# These match docker-compose.alt.yml defaults
export DATA_DIR=''${DATA_DIR:-"$HOME/.local/share/gitea-mirror"}
export DATABASE_URL=''${DATABASE_URL:-"file:$DATA_DIR/gitea-mirror.db"}
export HOST=''${HOST:-"0.0.0.0"}
export PORT=''${PORT:-"4321"}
export NODE_ENV=''${NODE_ENV:-"production"}

# Better Auth configuration
export BETTER_AUTH_URL=''${BETTER_AUTH_URL:-"http://localhost:4321"}
export BETTER_AUTH_TRUSTED_ORIGINS=''${BETTER_AUTH_TRUSTED_ORIGINS:-"http://localhost:4321"}
export PUBLIC_BETTER_AUTH_URL=''${PUBLIC_BETTER_AUTH_URL:-"http://localhost:4321"}

# Concurrency settings (match docker-compose.alt.yml)
export MIRROR_ISSUE_CONCURRENCY=''${MIRROR_ISSUE_CONCURRENCY:-3}
export MIRROR_PULL_REQUEST_CONCURRENCY=''${MIRROR_PULL_REQUEST_CONCURRENCY:-5}

# Create data directory
mkdir -p "$DATA_DIR"
cd $out/lib/gitea-mirror

# === AUTO-GENERATE SECRETS ===
BETTER_AUTH_SECRET_FILE="$DATA_DIR/.better_auth_secret"
ENCRYPTION_SECRET_FILE="$DATA_DIR/.encryption_secret"

# Generate BETTER_AUTH_SECRET if not provided
if [ -z "$BETTER_AUTH_SECRET" ]; then
  if [ -f "$BETTER_AUTH_SECRET_FILE" ]; then
    echo "Using previously generated BETTER_AUTH_SECRET"
    export BETTER_AUTH_SECRET=$(cat "$BETTER_AUTH_SECRET_FILE")
  else
    echo "Generating a secure random BETTER_AUTH_SECRET"
    GENERATED_SECRET=$(${pkgs.openssl}/bin/openssl rand -hex 32)
    export BETTER_AUTH_SECRET="$GENERATED_SECRET"
    echo "$GENERATED_SECRET" > "$BETTER_AUTH_SECRET_FILE"
    chmod 600 "$BETTER_AUTH_SECRET_FILE"
    echo "✅ BETTER_AUTH_SECRET generated and saved to $BETTER_AUTH_SECRET_FILE"
  fi
fi

# Generate ENCRYPTION_SECRET if not provided
if [ -z "$ENCRYPTION_SECRET" ]; then
  if [ -f "$ENCRYPTION_SECRET_FILE" ]; then
    echo "Using previously generated ENCRYPTION_SECRET"
    export ENCRYPTION_SECRET=$(cat "$ENCRYPTION_SECRET_FILE")
  else
    echo "Generating a secure random ENCRYPTION_SECRET"
    GENERATED_ENCRYPTION_SECRET=$(${pkgs.openssl}/bin/openssl rand -base64 36)
    export ENCRYPTION_SECRET="$GENERATED_ENCRYPTION_SECRET"
    echo "$GENERATED_ENCRYPTION_SECRET" > "$ENCRYPTION_SECRET_FILE"
    chmod 600 "$ENCRYPTION_SECRET_FILE"
    echo "✅ ENCRYPTION_SECRET generated and saved to $ENCRYPTION_SECRET_FILE"
  fi
fi

# === DATABASE INITIALIZATION ===
DB_PATH=$(echo "$DATABASE_URL" | sed 's|^file:||')
if [ ! -f "$DB_PATH" ]; then
  echo "Database not found. It will be created and initialized via Drizzle migrations on first app startup..."
  touch "$DB_PATH"
else
  echo "Database already exists, Drizzle will check for pending migrations on startup..."
fi

# === STARTUP SCRIPTS ===
# Initialize configuration from environment variables
echo "Checking for environment configuration..."
if [ -f "dist/scripts/startup-env-config.js" ]; then
  echo "Loading configuration from environment variables..."
  ${pkgs.bun}/bin/bun dist/scripts/startup-env-config.js && \
    echo "✅ Environment configuration loaded successfully" || \
    echo "⚠️  Environment configuration loading completed with warnings"
fi

# Run startup recovery
echo "Running startup recovery..."
if [ -f "dist/scripts/startup-recovery.js" ]; then
  ${pkgs.bun}/bin/bun dist/scripts/startup-recovery.js --timeout=30000 && \
    echo "✅ Startup recovery completed successfully" || \
    echo "⚠️  Startup recovery completed with warnings"
fi

# Run repository status repair
echo "Running repository status repair..."
if [ -f "dist/scripts/repair-mirrored-repos.js" ]; then
  ${pkgs.bun}/bin/bun dist/scripts/repair-mirrored-repos.js --startup && \
    echo "✅ Repository status repair completed successfully" || \
    echo "⚠️  Repository status repair completed with warnings"
fi

# === SIGNAL HANDLING ===
shutdown_handler() {
  echo "🛑 Received shutdown signal, forwarding to application..."
  if [ ! -z "$APP_PID" ]; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  exit 0
}

trap 'shutdown_handler' TERM INT HUP

# === START APPLICATION ===
echo "Starting Gitea Mirror..."
echo "Access the web interface at $BETTER_AUTH_URL"
${pkgs.bun}/bin/bun dist/server/entry.mjs &
APP_PID=$!

wait "$APP_PID"
EOF
            chmod +x $out/bin/gitea-mirror

            # Create database management helper
            cat > $out/bin/gitea-mirror-db <<'EOF'
#!/usr/bin/env bash
export DATA_DIR=''${DATA_DIR:-"$HOME/.local/share/gitea-mirror"}
mkdir -p "$DATA_DIR"
cd $out/lib/gitea-mirror
exec ${pkgs.bun}/bin/bun scripts/manage-db.ts "$@"
EOF
            chmod +x $out/bin/gitea-mirror-db
          '';

          meta = with pkgs.lib; {
            description = "Self-hosted GitHub to Gitea mirroring service";
            homepage = "https://github.com/RayLabsHQ/gitea-mirror";
            license = licenses.mit;
            maintainers = [ ];
            platforms = platforms.linux ++ platforms.darwin;
          };
        };

      in
      {
        packages = {
          default = gitea-mirror;
          gitea-mirror = gitea-mirror;
        };

        # Development shell
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            sqlite
            openssl
          ];

          shellHook = ''
            echo "🚀 Gitea Mirror development environment"
            echo ""
            echo "Quick start:"
            echo "  bun install       # Install dependencies"
            echo "  bun run dev       # Start development server"
            echo "  bun run build     # Build for production"
            echo ""
            echo "Database:"
            echo "  bun run manage-db init   # Initialize database"
            echo "  bun run db:studio        # Open Drizzle Studio"
          '';
        };

        # NixOS module
        nixosModules.default = { config, lib, pkgs, ... }:
          with lib;
          let
            cfg = config.services.gitea-mirror;
          in {
            options.services.gitea-mirror = {
              enable = mkEnableOption "Gitea Mirror service";

              package = mkOption {
                type = types.package;
                default = self.packages.${system}.default;
                description = "The Gitea Mirror package to use";
              };

              dataDir = mkOption {
                type = types.path;
                default = "/var/lib/gitea-mirror";
                description = "Directory to store data and database";
              };

              user = mkOption {
                type = types.str;
                default = "gitea-mirror";
                description = "User account under which Gitea Mirror runs";
              };

              group = mkOption {
                type = types.str;
                default = "gitea-mirror";
                description = "Group under which Gitea Mirror runs";
              };

              host = mkOption {
                type = types.str;
                default = "0.0.0.0";
                description = "Host to bind to";
              };

              port = mkOption {
                type = types.port;
                default = 4321;
                description = "Port to listen on";
              };

              betterAuthUrl = mkOption {
                type = types.str;
                default = "http://localhost:4321";
                description = "Better Auth URL (external URL of the service)";
              };

              betterAuthTrustedOrigins = mkOption {
                type = types.str;
                default = "http://localhost:4321";
                description = "Comma-separated list of trusted origins for Better Auth";
              };

              mirrorIssueConcurrency = mkOption {
                type = types.int;
                default = 3;
                description = "Number of concurrent issue mirror operations (set to 1 for perfect ordering)";
              };

              mirrorPullRequestConcurrency = mkOption {
                type = types.int;
                default = 5;
                description = "Number of concurrent PR mirror operations (set to 1 for perfect ordering)";
              };

              environmentFile = mkOption {
                type = types.nullOr types.path;
                default = null;
                description = ''
                  Path to file containing environment variables.
                  Only needed if you want to set BETTER_AUTH_SECRET or ENCRYPTION_SECRET manually.
                  Otherwise, secrets will be auto-generated and stored in the data directory.

                  Example:
                    BETTER_AUTH_SECRET=your-32-character-secret-here
                    ENCRYPTION_SECRET=your-encryption-secret-here
                '';
              };

              openFirewall = mkOption {
                type = types.bool;
                default = false;
                description = "Open the firewall for the specified port";
              };
            };

            config = mkIf cfg.enable {
              users.users.${cfg.user} = {
                isSystemUser = true;
                group = cfg.group;
                home = cfg.dataDir;
                createHome = true;
              };

              users.groups.${cfg.group} = {};

              systemd.services.gitea-mirror = {
                description = "Gitea Mirror - GitHub to Gitea mirroring service";
                after = [ "network.target" ];
                wantedBy = [ "multi-user.target" ];

                environment = {
                  DATA_DIR = cfg.dataDir;
                  DATABASE_URL = "file:${cfg.dataDir}/gitea-mirror.db";
                  HOST = cfg.host;
                  PORT = toString cfg.port;
                  NODE_ENV = "production";
                  BETTER_AUTH_URL = cfg.betterAuthUrl;
                  BETTER_AUTH_TRUSTED_ORIGINS = cfg.betterAuthTrustedOrigins;
                  PUBLIC_BETTER_AUTH_URL = cfg.betterAuthUrl;
                  MIRROR_ISSUE_CONCURRENCY = toString cfg.mirrorIssueConcurrency;
                  MIRROR_PULL_REQUEST_CONCURRENCY = toString cfg.mirrorPullRequestConcurrency;
                };

                serviceConfig = {
                  Type = "simple";
                  User = cfg.user;
                  Group = cfg.group;
                  ExecStart = "${cfg.package}/bin/gitea-mirror";
                  Restart = "always";
                  RestartSec = "10s";

                  # Security hardening
                  NoNewPrivileges = true;
                  PrivateTmp = true;
                  ProtectSystem = "strict";
                  ProtectHome = true;
                  ReadWritePaths = [ cfg.dataDir ];

                  # Load environment file if specified (optional)
                  EnvironmentFile = mkIf (cfg.environmentFile != null) cfg.environmentFile;

                  # Graceful shutdown
                  TimeoutStopSec = "30s";
                  KillMode = "mixed";
                  KillSignal = "SIGTERM";
                };
              };

              # Health check timer (optional monitoring)
              systemd.timers.gitea-mirror-healthcheck = mkIf cfg.enable {
                description = "Gitea Mirror health check timer";
                wantedBy = [ "timers.target" ];
                timerConfig = {
                  OnBootSec = "5min";
                  OnUnitActiveSec = "5min";
                };
              };

              systemd.services.gitea-mirror-healthcheck = mkIf cfg.enable {
                description = "Gitea Mirror health check";
                after = [ "gitea-mirror.service" ];
                serviceConfig = {
                  Type = "oneshot";
                  ExecStart = "${pkgs.curl}/bin/curl -f http://${cfg.host}:${toString cfg.port}/api/health || true";
                  User = "nobody";
                };
              };

              networking.firewall = mkIf cfg.openFirewall {
                allowedTCPPorts = [ cfg.port ];
              };
            };
          };
      }
    ) // {
      # Overlay for adding to nixpkgs
      overlays.default = final: prev: {
        gitea-mirror = self.packages.${final.system}.default;
      };
    };
}
