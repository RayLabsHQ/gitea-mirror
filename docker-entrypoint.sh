#!/bin/sh
set -e

# Ensure data directory exists
mkdir -p /app/data

# Generate a secure JWT secret if one isn't provided or is using the default value
JWT_SECRET_FILE="/app/data/.jwt_secret"
if [ "$JWT_SECRET" = "your-secret-key-change-this-in-production" ] || [ -z "$JWT_SECRET" ]; then
  # Check if we have a previously generated secret
  if [ -f "$JWT_SECRET_FILE" ]; then
    echo "Using previously generated JWT secret"
    export JWT_SECRET=$(cat "$JWT_SECRET_FILE")
  else
    echo "Generating a secure random JWT secret"
    # Try to generate a secure random string using OpenSSL
    if command -v openssl >/dev/null 2>&1; then
      GENERATED_SECRET=$(openssl rand -hex 32)
    else
      # Fallback to using /dev/urandom if openssl is not available
      echo "OpenSSL not found, using fallback method for random generation"
      GENERATED_SECRET=$(head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1)
    fi
    export JWT_SECRET="$GENERATED_SECRET"
    # Save the secret to a file for persistence across container restarts
    echo "$GENERATED_SECRET" > "$JWT_SECRET_FILE"
    chmod 600 "$JWT_SECRET_FILE"
  fi
  echo "JWT_SECRET has been set to a secure random value"
fi

# Initialize or migrate the database
if [ ! -f "/app/data/gitea-mirror.db" ]; then
  echo "Initializing database..."
  if [ -f "scripts/manage-db.ts" ]; then
    bun scripts/manage-db.ts init
  elif [ -f "dist/scripts/manage-db.js" ]; then
    bun dist/scripts/manage-db.js init
  else
    echo "Error: Could not find database initialization script"
    exit 1
  fi
else
  echo "Database already exists, running migrations..."
  if [ -f "scripts/manage-db.ts" ]; then
    bun scripts/manage-db.ts migrate
  elif [ -f "dist/scripts/manage-db.js" ]; then
    bun dist/scripts/manage-db.js migrate
  else
    echo "Warning: Could not find migration script, continuing anyway"
  fi
fi

# Extract version from package.json and set as environment variable
if [ -f "package.json" ]; then
  export npm_package_version=$(grep -o '"version": *"[^"]*"' package.json | cut -d'"' -f4)
  echo "Setting application version: $npm_package_version"
fi

# Run startup recovery to handle any interrupted jobs
echo "Running startup recovery..."
if [ -f "dist/scripts/startup-recovery.js" ]; then
  echo "Running startup recovery using compiled script..."
  bun dist/scripts/startup-recovery.js --timeout=30000
  RECOVERY_EXIT_CODE=$?
elif [ -f "scripts/startup-recovery.ts" ]; then
  echo "Running startup recovery using TypeScript script..."
  bun scripts/startup-recovery.ts --timeout=30000
  RECOVERY_EXIT_CODE=$?
else
  echo "Warning: Startup recovery script not found. Skipping recovery."
  RECOVERY_EXIT_CODE=0
fi

# Log recovery result
if [ $RECOVERY_EXIT_CODE -eq 0 ]; then
  echo "✅ Startup recovery completed successfully"
elif [ $RECOVERY_EXIT_CODE -eq 1 ]; then
  echo "⚠️  Startup recovery completed with warnings"
else
  echo "❌ Startup recovery failed with exit code $RECOVERY_EXIT_CODE"
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
bun ./dist/server/entry.mjs &
APP_PID=$!

# Wait for the application to finish
wait "$APP_PID"