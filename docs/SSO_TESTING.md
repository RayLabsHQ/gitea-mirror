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
   - Verify provider was saved successfully
   - Check `/api/sso/providers` returns your providers

3. **Redirect URI mismatch**
   - Ensure the redirect URI in your OAuth app matches exactly:
     `http://localhost:PORT/api/auth/sso/callback/PROVIDER_ID`

4. **CORS errors**
   - Add your identity provider domain to CORS allowed origins if needed

### Debug Mode:

> **Note:** Better Auth uses its own logger and does **not** read the `DEBUG`
> environment variable (it is not based on the `debug` npm package). An older
> version of this guide suggested `DEBUG=better-auth:*` — that has no effect.

Better Auth's logger defaults to the `warn` level, so SSO/OIDC sign-in and
callback details are hidden. Set the log level to `debug` to surface the full
trace:

```bash
# Local dev
BETTER_AUTH_LOG_LEVEL=debug bun run dev
```

```yaml
# Docker Compose
services:
  gitea-mirror:
    environment:
      - BETTER_AUTH_LOG_LEVEL=debug
```

Then watch the server logs (e.g. `docker compose logs -f gitea-mirror`) while you
attempt an SSO login. Lines are prefixed with `[Better Auth]:`. Accepted values
are `debug`, `info`, `warn`, and `error`.

#### Debugging a login that bounces back to `/login`

If clicking the SSO button sends you to the provider and then straight back to
the login screen, the OAuth flow itself usually succeeded but **no session
cookie was persisted**. Work through these checks:

1. **Enable `BETTER_AUTH_LOG_LEVEL=debug`** (above) and look for errors during
   the `/api/auth/sso/callback/<provider-id>` request.
2. **Check for `?error=UNKNOWN` on the landing URL** (or `?error=account%20not%20linked` in dev).
   That's Better Auth's account-linking step refusing to attach the SSO identity
   to an existing email/password account. The debug log line to look for is
   `User already exist but account isn't linked to <providerId>`. The fix is
   almost always to set the SSO provider's **Domain** field to the email domain
   your users actually have — auto-linking is gated on that domain match.
   See [docs/SSO-OIDC-SETUP.md#account-linking](./SSO-OIDC-SETUP.md#account-linking).
3. **Check the redirect URI** registered in your IdP exactly matches
   `https://<your-domain>/api/auth/sso/callback/<provider-id>` (scheme, host,
   and provider ID — no trailing slash).
4. **Confirm the session cookie is set.** In the browser DevTools → Network,
   inspect the callback response for a `Set-Cookie: better-auth-session=…`
   header, and DevTools → Application → Cookies for the stored cookie. Behind a
   reverse proxy, ensure `BETTER_AUTH_URL` is your **external HTTPS** URL so the
   cookie is issued with the correct domain and `Secure` flag, and that the
   proxy forwards `X-Forwarded-Proto: https` and `X-Forwarded-Host`.
5. **A `401` on `/api/sso/applications` is unrelated** to client login — that
   endpoint backs the OAuth *provider* (consent) management UI and requires an
   existing session. It is not part of the Authentik/OIDC sign-in flow.

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