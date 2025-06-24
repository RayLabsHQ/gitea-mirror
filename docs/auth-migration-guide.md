# Authentication Migration Guide

This guide helps existing Gitea Mirror users migrate from environment variable-based authentication to the new UI-based configuration.

## What's New?

Gitea Mirror now supports configuring authentication through the web UI, making it easier for non-technical users to set up SSO and other authentication methods without editing configuration files.

## Key Changes

1. **UI Setup Wizard**: First-time users see a setup wizard to configure authentication
2. **Admin Settings**: Authentication can be changed via `/admin/settings`
3. **Database Storage**: Auth configuration is now stored in the database
4. **Environment Variables**: Still supported but UI configuration takes precedence

## Migration Scenarios

### Scenario 1: Fresh Installation

No migration needed! The setup wizard will guide you through authentication configuration on first run.

### Scenario 2: Existing Environment Variable Configuration

Your existing configuration continues to work. To migrate to UI configuration:

1. Log in as an admin user
2. Navigate to `/admin/settings`
3. Click the "Authentication" tab
4. Your current environment-based settings are displayed
5. Click "Save to Database" to persist them
6. Remove auth-related environment variables from your deployment

### Scenario 3: Docker Compose Users

If you're using docker-compose with environment variables:

```yaml
# Before - auth configured via environment
environment:
  - AUTH_METHOD=oidc
  - AUTH_OIDC_ISSUER_URL=https://auth.example.com
  - AUTH_OIDC_CLIENT_ID=gitea-mirror
  - AUTH_OIDC_CLIENT_SECRET=secret

# After - auth configured via UI
environment:
  # Remove auth-related variables
  # Keep only core settings
  - DATABASE_URL=file:data/gitea-mirror.db
  - JWT_SECRET=${JWT_SECRET}
```

### Scenario 4: Switching Authentication Methods

To change authentication methods (e.g., from local to OIDC):

1. Enable local fallback temporarily:
   - Via UI: Admin Settings → Authentication → Allow Local Fallback
   - Via env: `AUTH_ALLOW_LOCAL_FALLBACK=true`

2. Configure the new authentication method

3. Test with a new account

4. Disable local fallback once verified

## Backup Recommendations

Before migrating:

1. Backup your database: `cp data/gitea-mirror.db data/gitea-mirror.db.backup`
2. Note your current environment variables
3. Test in a staging environment if possible

## Rollback Procedure

If you need to rollback to environment-based configuration:

1. Remove auth configuration from database:
   ```bash
   sqlite3 data/gitea-mirror.db "DELETE FROM auth_configs;"
   ```

2. Restore your environment variables

3. Restart the application

## FAQ

**Q: Will my existing users still be able to log in?**
A: Yes, existing users are not affected. Only the configuration method changes.

**Q: Can I still use environment variables?**
A: Yes, environment variables are still supported as a fallback when no database configuration exists.

**Q: What happens if I have both UI and environment configuration?**
A: UI configuration takes precedence. Environment variables are ignored if database configuration exists.

**Q: Do I need to restart after changing auth settings in the UI?**
A: No, UI changes take effect immediately without restart.

**Q: Can I export my UI configuration back to environment variables?**
A: The Admin Settings page shows the equivalent environment variables for your current configuration.

## Getting Help

- Check logs for detailed error messages
- Review the [Authentication Guide](authentication-guide.md)
- Report issues on [GitHub](https://github.com/arunavo4/gitea-mirror/issues)