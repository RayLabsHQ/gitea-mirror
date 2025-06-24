DROP INDEX `users_username_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username` ON `users` (`username`);