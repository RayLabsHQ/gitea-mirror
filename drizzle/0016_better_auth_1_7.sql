CREATE TABLE `oauth_client_assertions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_client_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_client_resources_client_id` ON `oauth_client_resources` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_client_resources_resource_id` ON `oauth_client_resources` (`resource_id`);--> statement-breakpoint
CREATE TABLE `oauth_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer,
	`disabled` integer,
	`policy_version` integer,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_resources_identifier_unique` ON `oauth_resources` (`identifier`);--> statement-breakpoint
CREATE INDEX `idx_oauth_resources_identifier` ON `oauth_resources` (`identifier`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `issuer` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jwks` ADD `alg` text;--> statement-breakpoint
ALTER TABLE `jwks` ADD `crv` text;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `authorization_code_id` text;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `revoked` integer;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `confirmation` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `client_discovery_id` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `client_credentials_scopes` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `backchannel_logout_uri` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `backchannel_logout_session_required` integer;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `application_type` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `jwks` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `jwks_uri` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `dpop_bound_access_tokens` integer;--> statement-breakpoint
ALTER TABLE `oauth_consents` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauth_consents` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `authorization_code_id` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `rotated_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `rotation_replay_response` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `rotation_replay_expires_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `confirmation` text;--> statement-breakpoint
UPDATE `accounts` SET `issuer` = 'local:credential' WHERE `issuer` = '' AND `provider_id` = 'credential';--> statement-breakpoint
UPDATE `accounts` SET `issuer` = (SELECT `issuer` FROM `sso_providers` WHERE `sso_providers`.`provider_id` = `accounts`.`provider_id` LIMIT 1) WHERE `issuer` = '' AND EXISTS (SELECT 1 FROM `sso_providers` WHERE `sso_providers`.`provider_id` = `accounts`.`provider_id`);--> statement-breakpoint
UPDATE `accounts` SET `issuer` = 'local:oauth:' || `provider_id` WHERE `issuer` = '';
