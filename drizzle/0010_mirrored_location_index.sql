-- Add index for mirroredLocation lookups (used by name collision detection)
CREATE INDEX IF NOT EXISTS `idx_repositories_mirrored_location` ON `repositories` (`user_id`, `mirrored_location`);

-- Add unique partial index to enforce that no two repos for the same user
-- can claim the same non-empty mirroredLocation. This prevents race conditions
-- during concurrent batch mirroring of starred repos with duplicate names.
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_repositories_user_mirrored_location`
  ON `repositories` (`user_id`, `mirrored_location`)
  WHERE `mirrored_location` != '';
