-- GHSA-c6c2-hr73-h7hw: any signed-in account could register an SSO provider
-- for another user's email domain, and every provider was trusted to link
-- sign-ins to existing accounts with an email in its domain. From now on only
-- the instance owner (the first account created) manages providers. A provider
-- another account added can no longer be used to sign in (the SSO plugin
-- refuses providers whose domain is not verified) until the owner opens and
-- saves it in Settings. That also cuts off an account linked through it
-- before this fix. Nothing is deleted. created_at has whole
-- seconds only, so ties go to the row inserted first (rowid).
UPDATE `sso_providers` SET `domain_verified` = 0 WHERE `user_id` IS NOT (SELECT `id` FROM `users` ORDER BY `created_at` ASC, rowid ASC LIMIT 1);
