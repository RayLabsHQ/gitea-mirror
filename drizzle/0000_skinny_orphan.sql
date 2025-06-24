CREATE TABLE `auth_config` (
	`id` text PRIMARY KEY NOT NULL,
	`method` text DEFAULT 'local' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`allow_local_fallback` integer DEFAULT false NOT NULL,
	`forward_auth` text,
	`oidc` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `configs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`github_config` text NOT NULL,
	`gitea_config` text NOT NULL,
	`include` text DEFAULT '["*"]' NOT NULL,
	`exclude` text DEFAULT '[]' NOT NULL,
	`schedule_config` text NOT NULL,
	`cleanup_config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_configs_user_id` ON `configs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_configs_is_active` ON `configs` (`is_active`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`payload` text NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_events_user_channel` ON `events` (`user_id`,`channel`);--> statement-breakpoint
CREATE INDEX `idx_events_created_at` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_events_read` ON `events` (`read`);--> statement-breakpoint
CREATE TABLE `mirror_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text,
	`repository_name` text,
	`organization_id` text,
	`organization_name` text,
	`details` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text NOT NULL,
	`job_type` text DEFAULT 'mirror' NOT NULL,
	`batch_id` text,
	`total_items` integer,
	`completed_items` integer DEFAULT 0,
	`item_ids` text,
	`completed_item_ids` text DEFAULT '[]',
	`in_progress` integer DEFAULT false NOT NULL,
	`timestamp` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`last_checkpoint` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mirror_jobs_user_id` ON `mirror_jobs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_mirror_jobs_batch_id` ON `mirror_jobs` (`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_mirror_jobs_in_progress` ON `mirror_jobs` (`in_progress`);--> statement-breakpoint
CREATE INDEX `idx_mirror_jobs_job_type` ON `mirror_jobs` (`job_type`);--> statement-breakpoint
CREATE INDEX `idx_mirror_jobs_timestamp` ON `mirror_jobs` (`timestamp`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`config_id` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text NOT NULL,
	`membership_role` text DEFAULT 'member' NOT NULL,
	`is_included` integer DEFAULT true NOT NULL,
	`destination_org` text,
	`status` text DEFAULT 'imported' NOT NULL,
	`last_mirrored` integer,
	`error_message` text,
	`repository_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_id`) REFERENCES `configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_organizations_user_id` ON `organizations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_organizations_config_id` ON `organizations` (`config_id`);--> statement-breakpoint
CREATE INDEX `idx_organizations_status` ON `organizations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_organizations_is_included` ON `organizations` (`is_included`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`config_id` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`url` text NOT NULL,
	`clone_url` text NOT NULL,
	`owner` text NOT NULL,
	`organization` text,
	`mirrored_location` text DEFAULT '',
	`destination_org` text,
	`is_private` integer DEFAULT false NOT NULL,
	`is_fork` integer DEFAULT false NOT NULL,
	`forked_from` text,
	`has_issues` integer DEFAULT false NOT NULL,
	`is_starred` integer DEFAULT false NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`has_lfs` integer DEFAULT false NOT NULL,
	`has_submodules` integer DEFAULT false NOT NULL,
	`language` text,
	`description` text,
	`default_branch` text NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`status` text DEFAULT 'imported' NOT NULL,
	`last_mirrored` integer,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_id`) REFERENCES `configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_repositories_user_id` ON `repositories` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_repositories_config_id` ON `repositories` (`config_id`);--> statement-breakpoint
CREATE INDEX `idx_repositories_status` ON `repositories` (`status`);--> statement-breakpoint
CREATE INDEX `idx_repositories_owner` ON `repositories` (`owner`);--> statement-breakpoint
CREATE INDEX `idx_repositories_organization` ON `repositories` (`organization`);--> statement-breakpoint
CREATE INDEX `idx_repositories_is_fork` ON `repositories` (`is_fork`);--> statement-breakpoint
CREATE INDEX `idx_repositories_is_starred` ON `repositories` (`is_starred`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password` text,
	`email` text NOT NULL,
	`display_name` text,
	`auth_provider` text DEFAULT 'local' NOT NULL,
	`external_id` text,
	`external_username` text,
	`is_active` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_auth_provider` ON `users` (`auth_provider`);--> statement-breakpoint
CREATE INDEX `idx_users_external_id` ON `users` (`external_id`);