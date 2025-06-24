# v3.0.0 Migration Plan - Drizzle Migrations

## Overview
Version 3.0.0 will be a breaking change that moves the entire database management system to use Drizzle's built-in migration system. This will provide better maintainability, version control, and upgrade paths.

## Current Issues to Fix
1. **Fragmented Schema**: Schema definitions spread across multiple files
2. **Manual Table Creation**: Raw SQL in multiple places
3. **No Migration History**: No tracking of applied schema changes
4. **Complex Initialization**: Different paths for Docker vs manual installation
5. **Upgrade Issues**: Manual column checking and patching

## Migration Steps

### Phase 1: Consolidate Schema
- [x] Move all table definitions to `src/lib/db/schema.ts` 
- [ ] Remove raw SQL from `src/lib/db/index.ts`
- [ ] Remove SQL from `docker-entrypoint.sh`
- [ ] Remove manual migration functions

### Phase 2: Generate Initial Migration
- [ ] Create complete schema in Drizzle format
- [ ] Generate initial migration from schema
- [ ] Add migration metadata table

### Phase 3: Update Initialization
- [ ] Replace `manage-db.ts` with migration runner
- [ ] Update `docker-entrypoint.sh` to run migrations
- [ ] Add automatic migration on startup
- [ ] Remove all manual table creation

### Phase 4: Migration Path from v2.x
- [ ] Create upgrade script for existing users
- [ ] Detect v2.x database and migrate data
- [ ] Preserve all existing data
- [ ] Add rollback capability

### Phase 5: Testing
- [ ] Test fresh installation
- [ ] Test upgrade from v2.19.1
- [ ] Test Docker deployment
- [ ] Test manual deployment

## Breaking Changes
1. Database initialization process completely changed
2. Removal of `manage-db` script (replaced with migrations)
3. New migration commands required for schema updates
4. Minimum Bun version might need update

## Benefits
1. **Single Source of Truth**: All schema in one place
2. **Version Control**: Track all schema changes
3. **Automatic Migrations**: No manual SQL needed
4. **Better DevEx**: Use `drizzle-kit studio` for DB inspection
5. **Type Safety**: Full TypeScript types from schema
6. **Rollback Support**: Can revert migrations if needed

## Timeline
- v2.19.1: Patch release with manual fixes (done)
- v3.0.0-beta.1: Initial migration system
- v3.0.0-beta.2: Testing and feedback
- v3.0.0: Final release