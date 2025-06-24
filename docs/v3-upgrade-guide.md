# Gitea Mirror v3.0.0 Upgrade Guide

## ⚠️ Important Notice

**v3.0.0 is a major breaking release**. Due to fundamental changes in the database management system, direct upgrades from v2.x are not supported. You must export your configuration and reimport it.

## What's Changed

- Complete database rewrite using Drizzle ORM
- Automatic migration system
- TypeScript schema definition
- No more manual SQL or complex migration scripts

## Migration Path

### Option 1: Fresh Start (Recommended)
1. Note down your GitHub and Gitea configuration
2. Stop Gitea Mirror
3. Backup and remove old database
4. Install v3.0.0
5. Reconfigure through the UI

### Option 2: Manual Configuration Export
1. While on v2.x, export your configuration:
   - GitHub token and settings
   - Gitea URL and token
   - Organization strategies
   - Mirror settings
2. Stop Gitea Mirror
3. Backup old database: `cp data/gitea-mirror.db data/gitea-mirror.db.v2-backup`
4. Delete old database: `rm data/gitea-mirror.db`
5. Install v3.0.0
6. Reconfigure using exported settings

## Installation Steps

### Docker
```bash
# Stop old version
docker compose down

# Pull v3.0.0
git pull
git checkout v3.0.0

# Start fresh
docker compose up -d
```

### Manual Installation
```bash
# Stop service
sudo systemctl stop gitea-mirror

# Update code
git pull
git checkout v3.0.0
bun install
bun run build

# Remove old database
rm data/gitea-mirror.db

# Start service
sudo systemctl start gitea-mirror
```

## New Features in v3.0.0

- **Automatic Migrations**: Database updates itself
- **Type Safety**: Full TypeScript support
- **Drizzle Studio**: `bun run db:studio` for GUI access
- **Better Performance**: Optimized queries
- **Cleaner Codebase**: Removed 1000+ lines of migration code

## New Database Commands

```bash
bun scripts/manage-db.ts init     # Initialize new database
bun scripts/manage-db.ts check    # Check database health
bun scripts/manage-db.ts backup   # Create backup
bun run db:studio                 # Open GUI browser
```

## FAQ

**Q: Can I upgrade directly from v2.x?**
A: No, v3.0.0 requires a fresh database due to fundamental schema changes.

**Q: Will I lose my mirror history?**
A: Yes, but your repositories remain in Gitea. Only the mirror tracking data is reset.

**Q: What about my users?**
A: You'll need to recreate users, but authentication settings can be reconfigured.

**Q: Is downgrade possible?**
A: Yes, restore your v2 backup and use the old version.

## Support

For issues or questions:
- Check existing [GitHub Issues](https://github.com/arunavo4/gitea-mirror/issues)
- Create a new issue with v3.0.0 tag
- Join discussions for community help