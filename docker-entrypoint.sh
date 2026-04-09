#!/bin/sh
set -e


# Ensure data directory exists
mkdir -p /app/data

# Handle custom CA certificates
if [ -d "/app/certs" ] && [ "$(ls -A /app/certs/*.crt 2>/dev/null)" ]; then
  echo "Custom CA certificates found, configuring Node.js to use them..."
  
  # Combine all CA certificates into a bundle for Node.js
  CA_BUNDLE="/app/certs/ca-bundle.crt"
  > "$CA_BUNDLE"
  
  for cert in /app/certs/*.crt; do
    if [ -f "$cert" ]; then
      echo "Adding certificate: $(basename "$cert")"
      cat "$cert" >> "$CA_BUNDLE"
      echo "" >> "$CA_BUNDLE"  # Add newline between certificates
    fi
  done
  
  # Set Node.js to use the custom CA bundle
  export NODE_EXTRA_CA_CERTS="$CA_BUNDLE"
  echo "NODE_EXTRA_CA_CERTS set to: $NODE_EXTRA_CA_CERTS"
  
  # For Bun compatibility, also set the CA bundle in system location if writable
  if [ -f "/etc/ssl/certs/ca-certificates.crt" ] && [ -w "/etc/ssl/certs/" ]; then
    echo "Appending custom certificates to system CA bundle..."
    cat "$CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt
  fi
  
else
  echo "No custom CA certificates found in /app/certs"
fi

# Check if system CA bundle is mounted and use it (only if not already set)
if [ -z "$NODE_EXTRA_CA_CERTS" ] && [ -f "/etc/ssl/certs/ca-certificates.crt" ] && [ ! -L "/etc/ssl/certs/ca-certificates.crt" ]; then
  # Check if it's a mounted file (not the default symlink)
  if [ "$(stat -c '%d' /etc/ssl/certs/ca-certificates.crt 2>/dev/null)" != "$(stat -c '%d' / 2>/dev/null)" ] || \
     [ "$(stat -f '%d' /etc/ssl/certs/ca-certificates.crt 2>/dev/null)" != "$(stat -f '%d' / 2>/dev/null)" ]; then
    echo "System CA bundle mounted, configuring Node.js to use it..."
    export NODE_EXTRA_CA_CERTS="/etc/ssl/certs/ca-certificates.crt"
    echo "NODE_EXTRA_CA_CERTS set to: $NODE_EXTRA_CA_CERTS"
  fi
fi

# Optional: If GITEA_SKIP_TLS_VERIFY is set, configure accordingly
if [ "$GITEA_SKIP_TLS_VERIFY" = "true" ]; then
  echo "Warning: GITEA_SKIP_TLS_VERIFY is set to true. This is insecure!"
  export NODE_TLS_REJECT_UNAUTHORIZED=0
fi

# Generate a secure BETTER_AUTH_SECRET if one isn't provided or is using the default value
BETTER_AUTH_SECRET_FILE="/app/data/.better_auth_secret"
JWT_SECRET_FILE="/app/data/.jwt_secret"  # Old file for backward compatibility

if [ "$BETTER_AUTH_SECRET" = "your-secret-key-change-this-in-production" ] || [ -z "$BETTER_AUTH_SECRET" ]; then
  # Check if we have a previously generated secret
  if [ -f "$BETTER_AUTH_SECRET_FILE" ]; then
    echo "Using previously generated BETTER_AUTH_SECRET"
    export BETTER_AUTH_SECRET=$(cat "$BETTER_AUTH_SECRET_FILE")
  # Check for old JWT_SECRET file for backward compatibility
  elif [ -f "$JWT_SECRET_FILE" ]; then
    echo "Migrating from old JWT_SECRET to BETTER_AUTH_SECRET"
    export BETTER_AUTH_SECRET=$(cat "$JWT_SECRET_FILE")
    # Save to new file
    echo "$BETTER_AUTH_SECRET" > "$BETTER_AUTH_SECRET_FILE"
    chmod 600 "$BETTER_AUTH_SECRET_FILE"
    # Optionally remove old file after successful migration
    rm -f "$JWT_SECRET_FILE"
  else
    echo "Generating a secure random BETTER_AUTH_SECRET"
    # Try to generate a secure random string using OpenSSL
    if command -v openssl >/dev/null 2>&1; then
      GENERATED_SECRET=$(openssl rand -hex 32)
    else
      # Fallback to using /dev/urandom if openssl is not available
      echo "OpenSSL not found, using fallback method for random generation"
      GENERATED_SECRET=$(head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1)
    fi
    export BETTER_AUTH_SECRET="$GENERATED_SECRET"
    # Save the secret to a file for persistence across container restarts
    echo "$GENERATED_SECRET" > "$BETTER_AUTH_SECRET_FILE"
    chmod 600 "$BETTER_AUTH_SECRET_FILE"
  fi
  echo "BETTER_AUTH_SECRET has been set to a secure random value"
fi

# Generate a secure ENCRYPTION_SECRET if one isn't provided
ENCRYPTION_SECRET_FILE="/app/data/.encryption_secret"

if [ -z "$ENCRYPTION_SECRET" ]; then
  # Check if we have a previously generated secret
  if [ -f "$ENCRYPTION_SECRET_FILE" ]; then
    echo "Using previously generated ENCRYPTION_SECRET"
    export ENCRYPTION_SECRET=$(cat "$ENCRYPTION_SECRET_FILE")
  else
    echo "Generating a secure random ENCRYPTION_SECRET"
    # Generate a 48-character secret for encryption
    if command -v openssl >/dev/null 2>&1; then
      GENERATED_ENCRYPTION_SECRET=$(openssl rand -base64 36)
    else
      # Fallback to using /dev/urandom if openssl is not available
      echo "OpenSSL not found, using fallback method for encryption secret generation"
      GENERATED_ENCRYPTION_SECRET=$(head -c 36 /dev/urandom | base64 | tr -d '\n' | head -c 48)
    fi
    export ENCRYPTION_SECRET="$GENERATED_ENCRYPTION_SECRET"
    # Save the secret to a file for persistence across container restarts
    echo "$GENERATED_ENCRYPTION_SECRET" > "$ENCRYPTION_SECRET_FILE"
    chmod 600 "$ENCRYPTION_SECRET_FILE"
  fi
  echo "ENCRYPTION_SECRET has been set to a secure random value"
fi



# Skip dependency installation entirely for pre-built images
# Dependencies are already installed during the Docker build process

# Initialize the database if it doesn't exist
# Note: Drizzle migrations will be run automatically when the app starts (see src/lib/db/index.ts)
if [ ! -f "/app/data/gitea-mirror.db" ]; then
  echo "Database not found. It will be created and initialized via Drizzle migrations on first app startup..."
  # Create empty database file so migrations can run
  touch /app/data/gitea-mirror.db
else
  echo "Database already exists, Drizzle will check for pending migrations on startup..."
fi

# Extract version from package.json and set as environment variable
if [ -f "package.json" ]; then
  export npm_package_version=$(grep -o '"version": *"[^"]*"' package.json | cut -d'"' -f4)
  echo "Setting application version: $npm_package_version"
fi



# Initialize configuration from environment variables if provided
echo "Checking for environment configuration..."

# Only run the env config script if relevant env vars are set
# This avoids spawning a heavy Bun process on memory-constrained systems
HAS_ENV_CONFIG=false
if [ -n "$GITHUB_USERNAME" ] || [ -n "$GITHUB_TOKEN" ] || [ -n "$GITEA_URL" ] || [ -n "$GITEA_USERNAME" ] || [ -n "$GITEA_TOKEN" ]; then
  HAS_ENV_CONFIG=true
fi

if [ "$HAS_ENV_CONFIG" = "true" ]; then
  if [ -f "dist/scripts/startup-env-config.js" ]; then
    echo "Loading configuration from environment variables..."
    bun dist/scripts/startup-env-config.js || ENV_CONFIG_EXIT_CODE=$?
    ENV_CONFIG_EXIT_CODE=${ENV_CONFIG_EXIT_CODE:-0}
  elif [ -f "scripts/startup-env-config.ts" ]; then
    echo "Loading configuration from environment variables..."
    bun scripts/startup-env-config.ts || ENV_CONFIG_EXIT_CODE=$?
    ENV_CONFIG_EXIT_CODE=${ENV_CONFIG_EXIT_CODE:-0}
  else
    echo "Environment configuration script not found. Skipping."
    ENV_CONFIG_EXIT_CODE=0
  fi
else
  echo "No GitHub/Gitea environment variables found, skipping env config initialization."
  ENV_CONFIG_EXIT_CODE=0
fi

# Log environment config result
if [ $ENV_CONFIG_EXIT_CODE -eq 0 ]; then
  echo "✅ Environment configuration loaded successfully"
else
  echo "⚠️  Environment configuration loading completed with warnings"
fi

# Run startup recovery to handle any interrupted jobs
echo "Running startup recovery..."
RECOVERY_EXIT_CODE=0
if [ -f "dist/scripts/startup-recovery.js" ]; then
  echo "Running startup recovery using compiled script..."
  bun dist/scripts/startup-recovery.js --timeout=30000 || RECOVERY_EXIT_CODE=$?
elif [ -f "scripts/startup-recovery.ts" ]; then
  echo "Running startup recovery using TypeScript script..."
  bun scripts/startup-recovery.ts --timeout=30000 || RECOVERY_EXIT_CODE=$?
else
  echo "Warning: Startup recovery script not found. Skipping recovery."
fi

# Log recovery result
if [ $RECOVERY_EXIT_CODE -eq 0 ]; then
  echo "✅ Startup recovery completed successfully"
elif [ $RECOVERY_EXIT_CODE -eq 1 ]; then
  echo "⚠️  Startup recovery completed with warnings"
else
  echo "❌ Startup recovery failed with exit code $RECOVERY_EXIT_CODE"
fi

# Run repository status repair to fix any inconsistent mirroring states
echo "Running repository status repair..."
REPAIR_EXIT_CODE=0
if [ -f "dist/scripts/repair-mirrored-repos.js" ]; then
  echo "Running repository repair using compiled script..."
  bun dist/scripts/repair-mirrored-repos.js --startup || REPAIR_EXIT_CODE=$?
elif [ -f "scripts/repair-mirrored-repos.ts" ]; then
  echo "Running repository repair using TypeScript script..."
  bun scripts/repair-mirrored-repos.ts --startup || REPAIR_EXIT_CODE=$?
else
  echo "Warning: Repository repair script not found. Skipping repair."
fi

# Log repair result
if [ $REPAIR_EXIT_CODE -eq 0 ]; then
  echo "✅ Repository status repair completed successfully"
else
  echo "⚠️  Repository status repair completed with warnings (exit code $REPAIR_EXIT_CODE)"
fi

# Function to handle shutdown signals
shutdown_handler() {
  echo "🛑 Received shutdown signal, forwarding to application..."
  if [ ! -z "$APP_PID" ]; then
    kill -TERM "$APP_PID"
    wait "$APP_PID"
  fi
  exit 0
}

# Set up signal handlers
trap 'shutdown_handler' TERM INT HUP

# Start the application
echo "Starting Gitea Mirror..."
if [ -f "./scripts/runtime-server.ts" ]; then
  bun ./scripts/runtime-server.ts &
elif [ -f "./dist/scripts/runtime-server.js" ]; then
  bun ./dist/scripts/runtime-server.js &
else
  bun ./dist/server/entry.mjs &
fi
APP_PID=$!

# Wait for the application to finish
wait "$APP_PID"
