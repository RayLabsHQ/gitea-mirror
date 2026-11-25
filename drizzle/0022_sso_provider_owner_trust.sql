-- GHSA-c6c2-hr73-h7hw: any signed-in account could register an SSO provider
-- for another user's email domain, and every provider was trusted to link
-- sign-ins to existing accounts with an email in its domain. From now on only
-- the instance owner (the first account created) manages providers. A provider
-- another account added can no longer be used to sign in (the SSO plugin
-- refuses providers whose domain is not verified) until the owner opens and
-- saves it in Settings. Nothing is deleted. created_at has whole seconds only,
-- so ties go to the row inserted first (rowid).
UPDATE `sso_providers` SET `domain_verified` = 0 WHERE `user_id` IS NOT (SELECT `id` FROM `users` ORDER BY `created_at` ASC, rowid ASC LIMIT 1);
--> statement-breakpoint
-- Refusing new sign-ins does not end access someone already got through such
-- a provider. For every account that has a sign-in linked through one: end
-- its sessions, delete its OAuth tokens, and turn off its API keys. Keys are
-- turned off rather than deleted so the list still shows them, including any
-- the owner of the account does not recognize; new ones can be created. They
-- sign in again with a password, or through the provider once the owner has
-- saved it.
DELETE FROM `sessions` WHERE `user_id` IN (SELECT `a`.`user_id` FROM `accounts` `a` JOIN `sso_providers` `p` ON `p`.`provider_id` = `a`.`provider_id` WHERE `p`.`domain_verified` = 0);
--> statement-breakpoint
DELETE FROM `oauth_access_tokens` WHERE `user_id` IN (SELECT `a`.`user_id` FROM `accounts` `a` JOIN `sso_providers` `p` ON `p`.`provider_id` = `a`.`provider_id` WHERE `p`.`domain_verified` = 0);
--> statement-breakpoint
DELETE FROM `oauth_refresh_tokens` WHERE `user_id` IN (SELECT `a`.`user_id` FROM `accounts` `a` JOIN `sso_providers` `p` ON `p`.`provider_id` = `a`.`provider_id` WHERE `p`.`domain_verified` = 0);
--> statement-breakpoint
UPDATE `api_keys` SET `enabled` = 0 WHERE `reference_id` IN (SELECT `a`.`user_id` FROM `accounts` `a` JOIN `sso_providers` `p` ON `p`.`provider_id` = `a`.`provider_id` WHERE `p`.`domain_verified` = 0);
