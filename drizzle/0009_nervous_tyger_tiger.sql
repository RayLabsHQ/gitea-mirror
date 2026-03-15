CREATE TABLE `__new_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`config_id` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`normalized_full_name` text NOT NULL,
	`url` text NOT NULL,
	`clone_url` text NOT NULL,
	`owner` text NOT NULL,
	`organization` text,
	`mirrored_location` text DEFAULT '',
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
	`destination_org` text,
	`metadata` text,
	`imported_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`config_id`) REFERENCES `configs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_repositories` (
	`id`,
	`user_id`,
	`config_id`,
	`name`,
	`full_name`,
	`normalized_full_name`,
	`url`,
	`clone_url`,
	`owner`,
	`organization`,
	`mirrored_location`,
	`is_private`,
	`is_fork`,
	`forked_from`,
	`has_issues`,
	`is_starred`,
	`is_archived`,
	`size`,
	`has_lfs`,
	`has_submodules`,
	`language`,
	`description`,
	`default_branch`,
	`visibility`,
	`status`,
	`last_mirrored`,
	`error_message`,
	`destination_org`,
	`metadata`,
	`imported_at`,
	`created_at`,
	`updated_at`
)
SELECT
	`repositories`.`id`,
	`repositories`.`user_id`,
	`repositories`.`config_id`,
	`repositories`.`name`,
	`repositories`.`full_name`,
	`repositories`.`normalized_full_name`,
	`repositories`.`url`,
	`repositories`.`clone_url`,
	`repositories`.`owner`,
	`repositories`.`organization`,
	`repositories`.`mirrored_location`,
	`repositories`.`is_private`,
	`repositories`.`is_fork`,
	`repositories`.`forked_from`,
	`repositories`.`has_issues`,
	`repositories`.`is_starred`,
	`repositories`.`is_archived`,
	`repositories`.`size`,
	`repositories`.`has_lfs`,
	`repositories`.`has_submodules`,
	`repositories`.`language`,
	`repositories`.`description`,
	`repositories`.`default_branch`,
	`repositories`.`visibility`,
	`repositories`.`status`,
	`repositories`.`last_mirrored`,
	`repositories`.`error_message`,
	`repositories`.`destination_org`,
	`repositories`.`metadata`,
	COALESCE(
		(
			SELECT MIN(`mj`.`timestamp`)
			FROM `mirror_jobs` `mj`
			WHERE `mj`.`user_id` = `repositories`.`user_id`
				AND `mj`.`status` = 'imported'
				AND (
					(`mj`.`repository_id` IS NOT NULL AND `mj`.`repository_id` = `repositories`.`id`)
					OR (
						`mj`.`repository_id` IS NULL
						AND `mj`.`repository_name` IS NOT NULL
						AND (
							lower(trim(`mj`.`repository_name`)) = `repositories`.`normalized_full_name`
							OR lower(trim(`mj`.`repository_name`)) = lower(trim(`repositories`.`name`))
						)
					)
				)
		),
		`repositories`.`created_at`,
		unixepoch()
	) AS `imported_at`,
	`repositories`.`created_at`,
	`repositories`.`updated_at`
FROM `repositories`;
--> statement-breakpoint
DROP TABLE `repositories`;
--> statement-breakpoint
ALTER TABLE `__new_repositories` RENAME TO `repositories`;
--> statement-breakpoint
CREATE INDEX `idx_repositories_user_id` ON `repositories` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_repositories_config_id` ON `repositories` (`config_id`);
--> statement-breakpoint
CREATE INDEX `idx_repositories_status` ON `repositories` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_repositories_owner` ON `repositories` (`owner`);
--> statement-breakpoint
CREATE INDEX `idx_repositories_organization` ON `repositories` (`organization`);
--> statement-breakpoint
CREATE INDEX `idx_repositories_is_fork` ON `repositories` (`is_fork`);
--> statement-breakpoint
CREATE INDEX `idx_repositories_is_starred` ON `repositories` (`is_starred`);
--> statement-breakpoint
CREATE INDEX `idx_repositories_user_imported_at` ON `repositories` (`user_id`,`imported_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repositories_user_full_name` ON `repositories` (`user_id`,`full_name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repositories_user_normalized_full_name` ON `repositories` (`user_id`,`normalized_full_name`);
