#!/bin/bash
# Fix script for v2.19.0 upgrade issues
# This script helps users who upgraded from v2.16.3 or earlier to v2.19.0

echo "Gitea Mirror v2.19.0 Upgrade Fix Script"
echo "======================================"
echo ""

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "Error: Bun is not installed. Please install Bun first."
    echo "Run: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Find the database file
DB_PATH=""
if [ -f "data/gitea-mirror.db" ]; then
    DB_PATH="data/gitea-mirror.db"
elif [ -f "gitea-mirror.db" ]; then
    DB_PATH="gitea-mirror.db"
elif [ -f "/app/data/gitea-mirror.db" ]; then
    DB_PATH="/app/data/gitea-mirror.db"
else
    echo "Error: Could not find gitea-mirror.db database file"
    echo "Please run this script from the Gitea Mirror installation directory"
    exit 1
fi

echo "Found database at: $DB_PATH"
echo ""

# Run the auth config migration
echo "Running auth configuration migration..."
if [ -f "scripts/migrate-auth-config.ts" ]; then
    DATABASE_URL="file:$DB_PATH" bun scripts/migrate-auth-config.ts
elif [ -f "dist/scripts/migrate-auth-config.js" ]; then
    DATABASE_URL="file:$DB_PATH" bun dist/scripts/migrate-auth-config.js
else
    echo "Error: Could not find migration script"
    echo "Please ensure you're running this from the Gitea Mirror installation directory"
    exit 1
fi

echo ""
echo "Migration complete! You should now be able to access Gitea Mirror normally."
echo "If you're still seeing the setup wizard, try clearing your browser cache."