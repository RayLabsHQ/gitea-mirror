ALTER TABLE `organizations` ADD `source_id` text;--> statement-breakpoint
-- Pin each organization to the source its repositories came from, but only
-- when they agree on exactly one: organizations whose repos span several
-- sources (or have none) stay unpinned and keep following every source.
-- MIN() keeps the subquery scalar; a HAVING filter with no matching row
-- yields NULL, which leaves the column untouched.
UPDATE `organizations` SET `source_id` = (
	SELECT MIN(`repositories`.`source_id`)
	FROM `repositories`
	WHERE `repositories`.`user_id` = `organizations`.`user_id`
		AND `repositories`.`organization` = `organizations`.`name`
		AND `repositories`.`source_id` IS NOT NULL
	HAVING COUNT(DISTINCT `repositories`.`source_id`) = 1
)
WHERE `source_id` IS NULL;
