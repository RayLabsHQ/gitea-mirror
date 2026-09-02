ALTER TABLE `repositories` ADD `source_provider` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `source_url` text DEFAULT 'https://github.com' NOT NULL;