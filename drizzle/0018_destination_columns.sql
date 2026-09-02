ALTER TABLE `repositories` ADD `destination_provider` text DEFAULT 'gitea' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `destination_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `repositories` SET
  `destination_provider` = COALESCE((SELECT json_extract(`configs`.`gitea_config`, '$.provider') FROM `configs` WHERE `configs`.`id` = `repositories`.`config_id`), 'gitea'),
  `destination_url` = COALESCE((SELECT json_extract(`configs`.`gitea_config`, '$.url') FROM `configs` WHERE `configs`.`id` = `repositories`.`config_id`), '')
WHERE `destination_url` = '';--> statement-breakpoint
UPDATE `repositories` SET `destination_provider` = 'gitea' WHERE `destination_provider` NOT IN ('gitea', 'forgejo', 'github', 'gitlab');
