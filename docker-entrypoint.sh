#!/bin/sh
set -e

# Handle custom CA certificates
if [ -d "/usr/local/share/ca-certificates" ]; then
  # Check if there are any .crt files in the directory
  if ls /usr/local/share/ca-certificates/*.crt 1> /dev/null 2>&1; then
    echo "Installing custom CA certificates..."
    # Update CA certificates
    if command -v update-ca-certificates >/dev/null 2>&1; then
      update-ca-certificates
      echo "CA certificates updated successfully"
    else
      echo "Warning: update-ca-certificates command not found"
    fi
    
    # For Node.js/Bun, we need to combine all certificates into a single bundle
    if [ -f "/etc/ssl/certs/ca-certificates.crt" ]; then
      echo "Setting NODE_EXTRA_CA_CERTS to system CA bundle..."
      export NODE_EXTRA_CA_CERTS="/etc/ssl/certs/ca-certificates.crt"
    fi
  fi
fi

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



# Skip dependency installation entirely for pre-built images
# Dependencies are already installed during the Docker build process

# Initialize the database if it doesn't exist
if [ ! -f "/app/data/gitea-mirror.db" ]; then
  echo "Initializing database..."
  if [ -f "dist/scripts/init-db.js" ]; then
    bun dist/scripts/init-db.js
  elif [ -f "dist/scripts/manage-db.js" ]; then
    bun dist/scripts/manage-db.js init
  elif [ -f "scripts/manage-db.ts" ]; then
    bun scripts/manage-db.ts init
  else
    echo "Warning: Could not find database initialization scripts in dist/scripts."
    echo "Creating and initializing database manually..."

    # Create the database file
    touch /app/data/gitea-mirror.db

    # Initialize the database with required tables
    sqlite3 /app/data/gitea-mirror.db <<EOF
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS configs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      github_config TEXT NOT NULL,
      gitea_config TEXT NOT NULL,
      include TEXT NOT NULL DEFAULT '["*"]',
      exclude TEXT NOT NULL DEFAULT '[]',
      schedule_config TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      url TEXT NOT NULL,
      clone_url TEXT NOT NULL,
      owner TEXT NOT NULL,
      organization TEXT,
      mirrored_location TEXT DEFAULT '',
      is_private INTEGER NOT NULL DEFAULT 0,
      is_fork INTEGER NOT NULL DEFAULT 0,
      forked_from TEXT,
      has_issues INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      has_lfs INTEGER NOT NULL DEFAULT 0,
      has_submodules INTEGER NOT NULL DEFAULT 0,
      default_branch TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      status TEXT NOT NULL DEFAULT 'imported',
      last_mirrored INTEGER,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (config_id) REFERENCES configs(id)
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      membership_role TEXT NOT NULL DEFAULT 'member',
      is_included INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'imported',
      last_mirrored INTEGER,
      error_message TEXT,
      repository_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (config_id) REFERENCES configs(id)
    );

    CREATE TABLE IF NOT EXISTS mirror_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      repository_id TEXT,
      repository_name TEXT,
      organization_id TEXT,
      organization_name TEXT,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'imported',
      message TEXT NOT NULL,
      timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- New fields for job resilience
      job_type TEXT NOT NULL DEFAULT 'mirror',
      batch_id TEXT,
      total_items INTEGER,
      completed_items INTEGER DEFAULT 0,
      item_ids TEXT, -- JSON array as text
      completed_item_ids TEXT DEFAULT '[]', -- JSON array as text
      in_progress INTEGER NOT NULL DEFAULT 0, -- Boolean as integer
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      last_checkpoint TIMESTAMP,

      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mirror_jobs_user_id ON mirror_jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_mirror_jobs_batch_id ON mirror_jobs(batch_id);
    CREATE INDEX IF NOT EXISTS idx_mirror_jobs_in_progress ON mirror_jobs(in_progress);
    CREATE INDEX IF NOT EXISTS idx_mirror_jobs_job_type ON mirror_jobs(job_type);
    CREATE INDEX IF NOT EXISTS idx_mirror_jobs_timestamp ON mirror_jobs(timestamp);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      payload TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_user_channel ON events(user_id, channel);
    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_read ON events(read);
EOF
    echo "Database initialized with required tables."
  fi
else
  echo "Database already exists, checking for issues..."
  if [ -f "dist/scripts/fix-db-issues.js" ]; then
    bun dist/scripts/fix-db-issues.js
  elif [ -f "dist/scripts/manage-db.js" ]; then
    bun dist/scripts/manage-db.js fix
  elif [ -f "scripts/manage-db.ts" ]; then
    bun scripts/manage-db.ts fix
  fi

  # Run database migrations
  echo "Running database migrations..."

  # Update mirror_jobs table with new columns for resilience
  if [ -f "dist/scripts/update-mirror-jobs-table.js" ]; then
    echo "Updating mirror_jobs table..."
    bun dist/scripts/update-mirror-jobs-table.js
  elif [ -f "scripts/update-mirror-jobs-table.ts" ]; then
    echo "Updating mirror_jobs table using TypeScript script..."
    bun scripts/update-mirror-jobs-table.ts
  else
    echo "Warning: Could not find mirror_jobs table update script."
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

# Run repository status repair to fix any inconsistent mirroring states
echo "Running repository status repair..."
if [ -f "dist/scripts/repair-mirrored-repos.js" ]; then
  echo "Running repository repair using compiled script..."
  bun dist/scripts/repair-mirrored-repos.js --startup
  REPAIR_EXIT_CODE=$?
elif [ -f "scripts/repair-mirrored-repos.ts" ]; then
  echo "Running repository repair using TypeScript script..."
  bun scripts/repair-mirrored-repos.ts --startup
  REPAIR_EXIT_CODE=$?
else
  echo "Warning: Repository repair script not found. Skipping repair."
  REPAIR_EXIT_CODE=0
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
bun ./dist/server/entry.mjs &
APP_PID=$!

# Wait for the application to finish
wait "$APP_PID"
