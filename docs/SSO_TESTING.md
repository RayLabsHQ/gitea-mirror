# Local SSO Testing Guide

How to test SSO sign-in locally. The user guide is the [Authentication page](https://gitea-mirror.raylabs.io/docs/authentication/). The dev server runs on `http://localhost:4321`, which the redirect URIs below assume.

## Option 1: Using Google OAuth (Recommended for Quick Testing)

### Setup Steps:

1. **Create a Google OAuth Application**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing
   - Enable Google+ API
   - Go to "Credentials" → "Create Credentials" → "OAuth client ID"
   - Choose "Web application"
   - Add the authorized redirect URI `http://localhost:4321/api/auth/sso/callback/google-sso`

2. **Configure in Gitea Mirror**
   - Go to Configuration, Authentication, and click **Add provider** in the Identity Providers panel
   - Stay on the **OIDC / OAuth2** tab
   - Fill in:
     - Issuer URL: `https://accounts.google.com`, then click **Discover** to fill in the endpoints. Discover also replaces Email Domain, so do this first
     - Provider ID: `google-sso`
     - Email Domain: `gmail.com` (or your domain)
     - Client ID and Client Secret: from the Google console
     - Remove `offline_access` from the scopes; Google rejects it
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

- Issuer URL: `http://localhost:8080/realms/gitea-mirror`, then click **Discover**
- Provider ID: `keycloak`
- Email Domain: `example.com`
- Client ID: `gitea-mirror`
- Client Secret: from Keycloak

## Option 3: Using Mock SSO Provider (Development)

For testing without external dependencies, you can use a mock OIDC provider.

### Using oidc-provider-example:

```bash
# Clone and run mock provider
git clone https://github.com/panva/node-oidc-provider-example.git
cd node-oidc-provider-example
npm install
npm start
```

Note the port it prints. If you also run `docker-compose.dev.yml`, its Gitea uses port 3001.

### Configure in Gitea Mirror:

- Issuer URL: the provider's address, then click **Discover**
- Provider ID: `mock-provider`
- Email Domain: `test.com`
- Client ID: `foo`
- Client Secret: `bar`

Saving a provider fetches its discovery document unless all four endpoints and the scopes are sent, so the mock provider has to be running when you save.

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
   - The trusted origins come from `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, the saved providers and the request's own host. Set `BETTER_AUTH_URL` or add your address to `BETTER_AUTH_TRUSTED_ORIGINS`, then restart

2. **Provider not showing in login**
   - Check browser console for errors
   - Verify provider was saved successfully
   - Check `/api/sso/providers` returns your providers

3. **Redirect URI mismatch**
   - Ensure the redirect URI in your OAuth app matches exactly:
     `http://localhost:PORT/api/auth/sso/callback/PROVIDER_ID`

### Debug Mode:

> **Note:** Better Auth uses its own logger and does **not** read the `DEBUG`
> environment variable (it is not based on the `debug` npm package). An older
> version of this guide suggested `DEBUG=better-auth:*`, which has no effect.

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
   `User already exist but account isn't linked to <providerId>`. The usual fix is
   to set the SSO provider's **Email Domain** field to the email domain
   your users actually have. See
   [Account linking](https://gitea-mirror.raylabs.io/docs/authentication/#account-linking).
3. **Check the redirect URI** registered in your IdP exactly matches
   `https://<your-domain>/api/auth/sso/callback/<provider-id>` (scheme, host,
   and provider ID, no trailing slash).
4. **Confirm the session cookie is set.** In the browser DevTools → Network,
   inspect the callback response for a `Set-Cookie: better-auth.session_token=...`
   header (`__Secure-better-auth.session_token` over HTTPS), and DevTools → Application → Cookies for the stored cookie. Behind a
   reverse proxy, ensure `BETTER_AUTH_URL` is your **external HTTPS** URL so the
   cookie is issued with the correct domain and `Secure` flag, and that the
   proxy forwards `X-Forwarded-Proto: https` and `X-Forwarded-Host`.
5. **A `401` on `/api/sso/applications` is unrelated** to client login. That
   endpoint manages the apps that use Gitea Mirror as an OAuth provider and
   needs an existing session. It is not part of the SSO sign-in flow.

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

## Environment Variables

For production-like testing:

```env
BETTER_AUTH_URL=http://localhost:4321
BETTER_AUTH_SECRET=your-secret-key
```

## Next Steps

After successful SSO setup:
1. Test user attribute mapping
2. Configure role-based access
3. Test with your organization's actual IdP

SAML sign-in does not work in the current release, so there is nothing to test there yet.