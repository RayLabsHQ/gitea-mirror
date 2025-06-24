# Gitea Mirror v3.0.0 Upgrade Guide

## Overview

Version 3.0.0 introduces a complete database management rewrite using Drizzle ORM's migration system. This is a **breaking change** that requires careful migration from v2.x.

## Prerequisites

1. **You MUST be on v2.19.1** before upgrading to v3.0.0
2. Make a backup of your database before upgrading
3. Ensure you have sufficient disk space for the backup

## Breaking Changes

### Database Management
- Removed `manage-db.ts` subcommands (replaced with new commands)
- Database initialization now uses Drizzle migrations
- All table creation SQL removed from `docker-entrypoint.sh`
- Schema is now defined in TypeScript instead of raw SQL

### API Changes
- All database queries now use Drizzle ORM
- Type definitions generated from schema
- Timestamps stored as Unix timestamps (integers) instead of ISO strings

### Configuration Changes
- Database migrations run automatically on startup
- No manual table creation needed
- Migration history tracked in `__drizzle_migrations` table

## Upgrade Steps

### Step 1: Verify Current Version

Ensure you're on v2.19.1:

```bash
# Check current version
cat package.json | grep version

# If not on v2.19.1, upgrade first:
git pull
git checkout v2.19.1
bun install
bun run build
```

### Step 2: Backup Your Database

```bash
# Manual installation
cp data/gitea-mirror.db data/gitea-mirror.db.backup-v2

# Docker installation
docker compose exec gitea-mirror cp /app/data/gitea-mirror.db /app/data/gitea-mirror.db.backup-v2
```

### Step 3: Stop Gitea Mirror

```bash
# Systemd
sudo systemctl stop gitea-mirror

# Docker
docker compose down
```

### Step 4: Upgrade to v3.0.0

```bash
# Pull latest code
git pull
git checkout v3.0.0

# Install dependencies
bun install

# Build application
bun run build
```

### Step 5: Run Migration Check

```bash
# Check if your database is ready for v3
bun scripts/migrate-v2-to-v3.ts

# This will:
# - Verify database structure
# - Check for required columns
# - Create a backup
# - Prepare for migration
```

### Step 6: Start Gitea Mirror

The migration will run automatically on first startup:

```bash
# Manual installation
bun run start

# Docker
docker compose up -d
```

### Step 7: Verify Migration

```bash
# Check database health
bun scripts/manage-db.ts check

# You should see:
# - Migration history with at least one entry
# - All tables present
# - User/config counts matching pre-upgrade
```

## Troubleshooting

### Migration Fails

If migration fails on startup:

1. Check logs for specific error
2. Restore from backup:
   ```bash
   cp data/gitea-mirror.db.backup-v2 data/gitea-mirror.db
   ```
3. Report issue with error details

### Missing Columns Error

If you see "Missing user columns" error:

1. You're not on v2.19.1 - upgrade to v2.19.1 first
2. Run manual migration:
   ```bash
   # On v2.19.1
   bun scripts/migrate-auth-config.ts
   ```

### Application Won't Start

1. Check if database file exists and is readable
2. Verify migrations folder exists: `ls drizzle/`
3. Check logs for specific errors
4. Try running migrations manually:
   ```bash
   bun scripts/manage-db.ts migrate
   ```

## Rollback Procedure

If you need to rollback to v2.x:

1. Stop Gitea Mirror
2. Restore database backup:
   ```bash
   cp data/gitea-mirror.db.backup-v2 data/gitea-mirror.db
   ```
3. Checkout v2.19.1:
   ```bash
   git checkout v2.19.1
   bun install
   bun run build
   ```
4. Start Gitea Mirror

## New Database Commands

### v2.x (deprecated)
```bash
bun scripts/manage-db.ts init        # Initialize database
bun scripts/manage-db.ts fix         # Fix issues
bun scripts/manage-db.ts reset-users # Delete all users
```

### v3.0.0 (new)
```bash
bun scripts/manage-db.ts init        # Initialize with migrations
bun scripts/manage-db.ts migrate     # Run pending migrations
bun scripts/manage-db.ts check       # Health check with migration info
bun scripts/manage-db.ts backup      # Create timestamped backup
bun scripts/manage-db.ts reset-users # Delete all users (unchanged)

# Additional Drizzle commands
bun run db:generate  # Generate new migration from schema changes
bun run db:push      # Push schema directly (dev only)
bun run db:studio    # Open Drizzle Studio GUI
```

## For Docker Users

Docker compose will handle the migration automatically. The updated `docker-entrypoint.sh`:

1. Checks for existing database
2. Runs `manage-db.ts init` for new installations
3. Runs `manage-db.ts migrate` for existing databases
4. Starts the application

No manual intervention needed for Docker deployments.

## Developer Notes

### Schema Location
- v2.x: SQL in multiple files, raw SQL queries
- v3.0.0: TypeScript schema in `/src/lib/db/schema.ts`

### Making Schema Changes
1. Edit `/src/lib/db/schema.ts`
2. Generate migration: `bun run db:generate`
3. Apply migration: `bun run db:migrate`
4. Commit both schema and migration files

### Type Safety
All database operations now have full TypeScript support:

```typescript
// Old (v2.x)
const user = sqlite.query("SELECT * FROM users WHERE id = ?").get(id);

// New (v3.0.0)
const user = await db.select().from(users).where(eq(users.id, id)).limit(1);
```

## Support

If you encounter issues:

1. Check this guide first
2. Search existing issues on GitHub
3. Create new issue with:
   - Current version
   - Error messages
   - Migration output
   - Database check output