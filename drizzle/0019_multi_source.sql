CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`url` text NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`token` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sources_user_id` ON `sources` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sources_user_provider_url_username` ON `sources` (`user_id`,`provider`,`url`,`username`);--> statement-breakpoint
-- Seed one source row per ACTIVE config that carries connection fields. The
-- token is copied as-is: it is already encrypted at rest in the config.
-- INSERT OR IGNORE guards the unique index for accounts that somehow kept
-- multiple config rows with identical connection values (configs has no
-- per-user unique constraint). Active configs only: the app reads the
-- active config, so seeding from a stale inactive row would elect a primary
-- source the user no longer uses.
INSERT OR IGNORE INTO `sources` (`id`, `user_id`, `name`, `provider`, `url`, `username`, `token`, `enabled`, `created_at`, `updated_at`)
WITH `connection` AS (
	SELECT
		`configs`.`user_id` AS `user_id`,
		CASE json_extract(`configs`.`github_config`, '$.provider')
			WHEN 'gitlab' THEN 'gitlab'
			WHEN 'gitea' THEN 'gitea'
			WHEN 'forgejo' THEN 'gitea'
			WHEN 'codeberg' THEN 'gitea'
			WHEN 'github' THEN 'github'
			ELSE 'github'
		END AS `provider`,
		rtrim(COALESCE(json_extract(`configs`.`github_config`, '$.url'), ''), '/') AS `url`,
		COALESCE(json_extract(`configs`.`github_config`, '$.owner'), '') AS `username`,
		COALESCE(json_extract(`configs`.`github_config`, '$.token'), '') AS `token`
	FROM `configs`
	WHERE `configs`.`is_active` = 1
		AND (
			COALESCE(json_extract(`configs`.`github_config`, '$.token'), '') <> ''
			OR COALESCE(json_extract(`configs`.`github_config`, '$.owner'), '') <> ''
		)
)
SELECT
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
	`user_id`,
	CASE `provider`
		WHEN 'github' THEN 'GitHub'
		WHEN 'gitlab' THEN 'GitLab'
		ELSE 'Gitea / Forgejo'
	END || (CASE WHEN `username` = '' THEN '' ELSE ' (' || `username` || ')' END),
	`provider`,
	CASE
		WHEN `url` <> '' THEN `url`
		WHEN `provider` = 'github' THEN 'https://github.com'
		WHEN `provider` = 'gitlab' THEN 'https://gitlab.com'
		ELSE 'https://codeberg.org'
	END,
	`username`,
	NULLIF(`token`, ''),
	1,
	unixepoch(),
	unixepoch()
FROM `connection`;--> statement-breakpoint
ALTER TABLE `repositories` ADD `source_id` text;--> statement-breakpoint
-- Link each repository to its user's source row with the same provider and
-- host. MIN() keeps the subquery scalar; rows without a match keep NULL
-- ("switched source" legacy rows that deliberately match no source).
UPDATE `repositories` SET `source_id` = (
	SELECT MIN(`sources`.`id`)
	FROM `sources`
	WHERE `sources`.`user_id` = `repositories`.`user_id`
		AND `sources`.`provider` = `repositories`.`source_provider`
		AND rtrim(`sources`.`url`, '/') = rtrim(`repositories`.`source_url`, '/')
)
WHERE `source_id` IS NULL;--> statement-breakpoint
DROP INDEX `uniq_repositories_user_full_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repositories_user_full_name` ON `repositories` (`user_id`,`source_id`,`full_name`);--> statement-breakpoint
DROP INDEX `uniq_repositories_user_normalized_full_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_repositories_user_normalized_full_name` ON `repositories` (`user_id`,`source_id`,`normalized_full_name`);
