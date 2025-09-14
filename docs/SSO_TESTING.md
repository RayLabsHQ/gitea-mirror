# Local SSO Testing Guide

This guide explains how to test SSO authentication locally with Gitea Mirror.

## Option 1: Using Google OAuth (Recommended for Quick Testing)

### Setup Steps:

1. **Create a Google OAuth Application**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing
   - Enable Google+ API
   - Go to "Credentials" → "Create Credentials" → "OAuth client ID"
   - Choose "Web application"
   - Add authorized redirect URIs:
     - `http://localhost:3000/api/auth/sso/callback/google-sso`
     - `http://localhost:9876/api/auth/sso/callback/google-sso`

2. **Configure in Gitea Mirror**
   - Go to Configuration → Authentication tab
   - Click "Add Provider"
   - Select "OIDC / OAuth2"
   - Fill in:
     - Provider ID: `google-sso`
     - Email Domain: `gmail.com` (or your domain)
     - Issuer URL: `https://accounts.google.com`
     - Click "Discover" to auto-fill endpoints
     - Client ID: (from Google Console)
     - Client Secret: (from Google Console)
   - Save the provider

   Note: Provider creation uses Better Auth's SSO registration under the hood. Do not call the legacy `POST /api/sso/providers` endpoint directly; it is deprecated and reserved for internal mirroring. Use the UI or Better Auth client/server registration APIs instead.

## Option 2: Using Keycloak (Local Identity Provider)

### Setup with Docker:

```bash
# Run Keycloak
docker run -d --name keycloak \
  -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev

# Access at http://localhost:8080
# Login with admin/admin
```

### Configure Keycloak:

1. Create a new realm (e.g., "gitea-mirror")
2. Create a client:
   - Client ID: `gitea-mirror`
   - Client Protocol: `openid-connect`
   - Access Type: `confidential`
   - Valid Redirect URIs: `http://localhost:*/api/auth/sso/callback/keycloak`
3. Get credentials from the "Credentials" tab
4. Create test users in "Users" section

### Configure in Gitea Mirror:

- Provider ID: `keycloak`
- Email Domain: `example.com`
- Issuer URL: `http://localhost:8080/realms/gitea-mirror`
- Client ID: `gitea-mirror`
- Client Secret: (from Keycloak)
- Click "Discover" to auto-fill endpoints

## Option 3: Using Mock SSO Provider (Development)

For testing without external dependencies, you can use a mock OIDC provider.

### Using oidc-provider-example:

```bash
# Clone and run mock provider
git clone https://github.com/panva/node-oidc-provider-example.git
cd node-oidc-provider-example
npm install
npm start

# Runs on http://localhost:3001
```

### Configure in Gitea Mirror:

- Provider ID: `mock-provider`
- Email Domain: `test.com`
- Issuer URL: `http://localhost:3001`
- Client ID: `foo`
- Client Secret: `bar`
- Authorization Endpoint: `http://localhost:3001/auth`
- Token Endpoint: `http://localhost:3001/token`

## Testing the SSO Flow

1. **Logout** from Gitea Mirror if logged in
2. Go to `/login`
3. Click on the **SSO** tab
4. Either:
   - Click the provider button (e.g., "Sign in with gmail.com")
   - Or enter your email and click "Continue with SSO"
5. You'll be redirected to the identity provider
6. Complete authentication
7. You'll be redirected back and logged in

## Troubleshooting

### Common Issues:

1. **"Invalid origin" error**
   - Check that `trustedOrigins` in `/src/lib/auth.ts` includes your dev URL
   - Restart the dev server after changes

2. **Provider not showing in login**
   - Check browser console for errors
   - Verify provider was saved successfully (via UI)
   - Check `/api/sso/providers` (or `/api/sso/providers/public`) returns your providers. This list mirrors what was registered with Better Auth.

3. **Redirect URI mismatch**
   - Ensure the redirect URI in your OAuth app matches exactly:
     `http://localhost:PORT/api/auth/sso/callback/PROVIDER_ID`

4. **CORS errors**
   - Add your identity provider domain to CORS allowed origins if needed

### Debug Mode:

Enable debug logging by setting environment variable:
```bash
DEBUG=better-auth:* bun run dev
```

## Testing Different Scenarios

### 1. New User Registration
- Use an email not in the system
- SSO should create a new user automatically

### 2. Existing User Login
- Create a user with email/password first
- Login with SSO using same email
- Should link to existing account

### 3. Domain-based Routing
- Configure multiple providers with different domains
- Test that entering email routes to correct provider

### 4. Organization Provisioning
- Set organizationId on provider
- Test that users are added to correct organization

## Security Testing

1. **Token Expiration**
   - Wait for session to expire
   - Test refresh flow

2. **Invalid State**
   - Modify state parameter in callback
   - Should reject authentication

3. **PKCE Flow**
   - Enable/disable PKCE
   - Verify code challenge works

## Using with Better Auth CLI

Better Auth provides CLI tools for testing:

```bash
# List registered providers
bun run auth:providers list

# Test provider configuration
bun run auth:providers test google-sso
```

## Environment Variables

For production-like testing:

```env
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=your-secret-key
```

## Next Steps

After successful SSO setup:
1. Test user attribute mapping
2. Configure role-based access
3. Set up SAML if needed
4. Test with your organization's actual IdP
