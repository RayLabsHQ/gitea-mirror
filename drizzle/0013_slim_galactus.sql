PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`config_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`avatar_url` text NOT NULL,
	`membership_role` text DEFAULT 'member' NOT NULL,
	`is_included` integer DEFAULT true NOT NULL,
	`destination_org` text,
	`status` text DEFAULT 'imported' NOT NULL,
	`last_mirrored` integer,
	`error_message` text,
	`repository_count` integer DEFAULT 0 NOT NULL,
	`public_repository_count` integer,
	`private_repository_count` integer,
	`fork_repository_count` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`config_id`) REFERENCES `configs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_organizations`("id", "user_id", "config_id", "name", "normalized_name", "avatar_url", "membership_role", "is_included", "destination_org", "status", "last_mirrored", "error_message", "repository_count", "public_repository_count", "private_repository_count", "fork_repository_count", "created_at", "updated_at") SELECT "id", "user_id", "config_id", "name", "normalized_name", "avatar_url", "membership_role", "is_included", "destination_org", "status", "last_mirrored", "error_message", "repository_count", "public_repository_count", "private_repository_count", "fork_repository_count", "created_at", "updated_at" FROM `organizations`;--> statement-breakpoint
DROP TABLE `organizations`;--> statement-breakpoint
ALTER TABLE `__new_organizations` RENAME TO `organizations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_organizations_user_id` ON `organizations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_organizations_config_id` ON `organizations` (`config_id`);--> statement-breakpoint
CREATE INDEX `idx_organizations_status` ON `organizations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_organizations_is_included` ON `organizations` (`is_included`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_organizations_user_normalized_name` ON `organizations` (`user_id`,`normalized_name`);--> statement-breakpoint
ALTER TABLE `sso_providers` ADD `saml_config` text;--> statement-breakpoint
ALTER TABLE `sso_providers` ADD `domain_verified` integer DEFAULT true NOT NULL;