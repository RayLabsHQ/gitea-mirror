# Authentication Setup Flow Test Guide

This guide helps you test the new authentication setup flow in Gitea Mirror.

## Test Scenarios

### 1. Fresh Installation - Local Auth (Default)

```bash
# Clear existing data
rm -rf data/

# Start with environment variables for local auth
AUTH_METHOD=local bun run dev

# Expected behavior:
# 1. Visit http://localhost:3000
# 2. Should redirect to /setup
# 3. Setup wizard appears with "Local Authentication" selected
# 4. Click "Continue"
# 5. Should redirect to /signup
# 6. Create admin account
# 7. Login works with username/password
```

### 2. Fresh Installation - OIDC Setup

```bash
# Clear existing data
rm -rf data/

# Start without auth env vars
bun run dev

# Expected behavior:
# 1. Visit http://localhost:3000
# 2. Should redirect to /setup
# 3. Select "SSO / OIDC" in setup wizard
# 4. Enable "Allow local authentication as fallback"
# 5. Fill in OIDC details:
#    - Issuer URL: https://auth.example.com/application/o/gitea-mirror/
#    - Client ID: gitea-mirror
#    - Client Secret: your-secret
# 6. Click "Save Configuration"
# 7. Should redirect to /signup
# 8. Both SSO button and local login form should be visible
```

### 3. Fresh Installation - Forward Auth

```bash
# Clear existing data
rm -rf data/

# Start without auth env vars
bun run dev

# Expected behavior:
# 1. Visit http://localhost:3000
# 2. Should redirect to /setup
# 3. Select "Forward Authentication" in setup wizard
# 4. Fill in forward auth details:
#    - Username Header: X-Remote-User
#    - Email Header: X-Remote-Email
#    - Trusted Proxies: 127.0.0.1, 10.0.0.0/8
# 5. Click "Save Configuration"
# 6. Should redirect to /signup
# 7. If no headers present, should show error
```

### 4. Environment Variable Override

```bash
# Clear existing data
rm -rf data/

# Start with OIDC env vars
cat > .env << EOF
AUTH_METHOD=oidc
AUTH_OIDC_ISSUER_URL=https://auth.example.com/application/o/gitea-mirror/
AUTH_OIDC_CLIENT_ID=gitea-mirror
AUTH_OIDC_CLIENT_SECRET=secret123
AUTH_ALLOW_LOCAL_FALLBACK=true
EOF

bun run dev

# Expected behavior:
# 1. Visit http://localhost:3000
# 2. Should skip setup and go directly to /signup
# 3. Login page should show SSO button and local form
# 4. Environment variables take precedence over database config
```

### 5. Admin Auth Settings Change

```bash
# After creating an admin account:

# 1. Login as admin
# 2. Go to Configuration page
# 3. Scroll to "Authentication Settings"
# 4. Click "Edit"
# 5. Change from Local to OIDC
# 6. Fill in OIDC details
# 7. Click "Save Changes"
# 8. Logout
# 9. Login page should now show SSO option
```

## Testing Checklist

- [ ] Setup wizard appears on fresh install
- [ ] Local auth setup works
- [ ] OIDC setup saves configuration
- [ ] Forward auth setup saves configuration
- [ ] Environment variables override database config
- [ ] Admin can change auth settings
- [ ] Login page reflects current auth method
- [ ] SSO button appears when OIDC is configured
- [ ] Local fallback works when enabled
- [ ] API endpoints require authentication

## Common Issues

1. **Setup wizard doesn't appear**
   - Check if `data/gitea-mirror.db` exists
   - Check if auth_config table has entries

2. **OIDC button doesn't show**
   - Check `/api/auth/config` response
   - Verify OIDC configuration is complete

3. **Can't save auth settings**
   - Ensure you're logged in as admin (first user)
   - Check browser console for errors

## Reset Everything

```bash
# Stop the server
# Then run:
rm -rf data/
rm .env
bun run dev
```