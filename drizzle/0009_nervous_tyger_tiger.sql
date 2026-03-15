ALTER TABLE `repositories` ADD `imported_at` integer DEFAULT (unixepoch()) NOT NULL;--> statement-breakpoint
UPDATE `repositories`
SET `imported_at` = COALESCE(
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
  `imported_at`
);--> statement-breakpoint
CREATE INDEX `idx_repositories_user_imported_at` ON `repositories` (`user_id`,`imported_at`);
