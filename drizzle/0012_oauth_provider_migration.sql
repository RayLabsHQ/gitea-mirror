-- Migrate the OAuth/OIDC *provider* feature from the deprecated
-- `oidc-provider` plugin to `@better-auth/oauth-provider`.
--
-- Tables: oauth_applications -> oauth_clients, oauth_access_tokens reshaped,
-- new oauth_refresh_tokens, oauth_consent -> oauth_consents, plus a `jwks`
-- table for the `jwt` plugin (id_token signing keys).
--
-- Data preservation:
--   * Registered clients are copied from oauth_applications into oauth_clients,
--     converting the legacy comma-separated `redirect_urls` into the JSON
--     string[] (`redirect_uris`) the new adapter expects.
--   * Access tokens and consent records are NOT migrated: access tokens are
--     short-lived (and the column shape changed entirely), and consents are
--     cheaply re-granted on next authorization. Both old tables are dropped.
--
-- NOTE: legacy client secrets were stored in plaintext, whereas the new
-- provider stores them hashed. Migrated client secrets will therefore not
-- validate as-is — affected applications must rotate their secret after
-- upgrade.

CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`name` text,
	`disabled` integer DEFAULT false,
	`skip_consent` integer,
	`enable_end_session` integer,
	`subject_type` text,
	`scopes` text,
	`user_id` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`token_endpoint_auth_method` text,
	`grant_types` text,
	`response_types` text,
	`public` integer,
	`type` text,
	`require_pkce` integer,
	`reference_id` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_unique` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_clients_client_id` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_clients_user_id` ON `oauth_clients` (`user_id`);--> statement-breakpoint
INSERT INTO `oauth_clients` (
	`id`, `client_id`, `client_secret`, `name`, `disabled`, `user_id`,
	`redirect_uris`, `type`, `metadata`, `created_at`, `updated_at`
)
SELECT
	`id`, `client_id`, `client_secret`, `name`, `disabled`, `user_id`,
	'["' || replace(`redirect_urls`, ',', '","') || '"]',
	`type`, `metadata`, `created_at`, `updated_at`
FROM `oauth_applications`;--> statement-breakpoint
DROP TABLE `oauth_applications`;--> statement-breakpoint
DROP TABLE `oauth_access_tokens`;--> statement-breakpoint
CREATE TABLE `oauth_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`refresh_id` text,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()),
	`scopes` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_tokens_token_unique` ON `oauth_access_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_tokens_token` ON `oauth_access_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_tokens_client_id` ON `oauth_access_tokens` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_access_tokens_user_id` ON `oauth_access_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`reference_id` text,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()),
	`revoked` integer,
	`auth_time` integer,
	`scopes` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_tokens_token_unique` ON `oauth_refresh_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_tokens_token` ON `oauth_refresh_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_tokens_client_id` ON `oauth_refresh_tokens` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_tokens_user_id` ON `oauth_refresh_tokens` (`user_id`);--> statement-breakpoint
DROP TABLE `oauth_consent`;--> statement-breakpoint
CREATE TABLE `oauth_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`scopes` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_consents_client_id` ON `oauth_consents` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_consents_user_id` ON `oauth_consents` (`user_id`);--> statement-breakpoint
CREATE TABLE `jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer
);
