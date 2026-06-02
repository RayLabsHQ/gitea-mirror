-- The upgraded `@better-auth/sso` plugin now supports SAML providers and
-- writes a `samlConfig` field on every ssoProviders insert (NULL for OIDC).
-- The Drizzle adapter rejects any field that isn't present in the schema, so
-- without this column SSO provider registration fails with:
--   BetterAuthError: The field "samlConfig" does not exist in the
--   "ssoProviders" Drizzle schema.
--
-- This adds the column as nullable (no default), so existing rows are
-- untouched and OIDC providers continue to leave it NULL.

ALTER TABLE `sso_providers` ADD COLUMN `saml_config` text;
