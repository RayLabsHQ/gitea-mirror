CREATE TABLE `mirror_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_server_id` text NOT NULL,
	`target_server_id` text NOT NULL,
	`mirror_type` text DEFAULT 'one-way' NOT NULL,
	`username` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`options` text DEFAULT '{"repositorySelection":{"mode":"all","selectedRepos":[],"includePatterns":[],"excludePatterns":[],"includeForks":false,"includeArchived":false,"includePrivate":true},"organizationStructure":{"strategy":"preserve"},"destructiveProtection":{"detectForcePush":true,"backupStrategy":"on-force-push","backupRetentionCount":5,"backupRetentionDays":30},"mirrorContent":{"releases":false,"lfs":false,"issues":false,"pullRequests":false,"labels":false,"milestones":false,"wiki":false}}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_mirror_pairs_user_id` ON `mirror_pairs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_mirror_pairs_source_server_id` ON `mirror_pairs` (`source_server_id`);--> statement-breakpoint
CREATE INDEX `idx_mirror_pairs_target_server_id` ON `mirror_pairs` (`target_server_id`);--> statement-breakpoint
CREATE INDEX `idx_mirror_pairs_enabled` ON `mirror_pairs` (`enabled`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`username` text NOT NULL,
	`token` text NOT NULL,
	`url` text NOT NULL,
	`external_url` text,
	`lfs_endpoint` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_servers_user_id` ON `servers` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_servers_type` ON `servers` (`type`);