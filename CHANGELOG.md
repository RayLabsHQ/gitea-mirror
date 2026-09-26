# Changelog

All notable changes to the Gitea Mirror project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- The Activity Log summary no longer shows a repository as syncing after a quick sync finished (#454). Events are stored to the second, and a sync that starts and finishes in the same second could come back in the wrong order, so the start event was counted as the current state. Activities now come back newest first within the same second too, and the summary counts a finish over a start from the same second
- Issue and pull request passes over large repositories finish across rate limit resets (#449 follow-up)
  - A pass stopped by the rate limit keeps the numbers it finished, and the next run repeats the same pass and skips them unless they changed since it started; before, every run started over from the first item, so a repository too large for one hour of budget never completed a pass
  - The weekly full pass no longer fetches comments for issues, or the detail, commits and files of pull requests, that are already in the destination and have not changed since the last completed pass; it lists everything and corrects title, body, state and labels from the listing
  - A sync paused by the rate limit logs one line instead of the error object with every partial result, and its activity entry says it was paused
- No request leaves the process while GitHub is rate limited (#437, second report)
  - The v3.37.0 change stopped the scheduler run from holding its lock through a rate limit, but every other request already queued in the run still went to GitHub and came back 403, and the retry helper sent each of them three more times; GitHub counts requests made while limited toward abuse detection and one account was suspended that way
  - Every GitHub client now holds its requests while the source is paused: a limit that resets within two minutes is waited out inside the request, a longer one fails the request at once without contacting GitHub, and the rate limit probe endpoint stays available so the pause can end early
  - The retry helper no longer retries a rate limit refusal and stops starting the remaining items of the batch
  - A rate limit refusal inside the issues, pull requests, releases, labels or milestones pass now fails the repository (which the scheduler already puts back to its previous status and retries after the reset) instead of moving on to the next component, and a pull request whose detail call was refused is no longer written as a stripped down issue
  - A secondary rate limit pauses the whole client for its retry-after window, not only the request that was told to slow down

### Security
- Source URLs go through the outbound guard too (GHSA-p7w3-46pg-mv6h): `POST /api/sources`, `PUT /api/sources/:id` and the configuration save refuse link local and metadata addresses for source and destination URLs, the source fetch helper pins and never follows redirects like the other user supplied URLs, source errors no longer carry the upstream body in their message, and errors raised by a request to another host are never forwarded to API clients whatever words they contain
- Fixed four privately reported vulnerabilities (GHSA-9m33-xfrc-5jxw, GHSA-6m23-28hh-gjh2, GHSA-2hpx-83vg-gm45, GHSA-5pp8-r7f5-6q8p)
  - `POST /api/gitea/test-connection` and `POST /api/github/test-connection` now require a signed-in user; they were the only non-public API routes without a guard and made a server side request to any URL in the body
  - The email sign-up endpoint is closed server side once an account exists (`AUTH_ALLOW_SIGNUP=true` reopens it); only the signup page redirected before, so anyone reaching the instance could create an account through the API
  - SSO providers are scoped to the user who created them for listing, updating and deleting, and the OIDC client secret is no longer returned by the API (the form keeps the stored secret when the field is left blank)
  - HTTP errors from Gitea and other hosts no longer carry the upstream response body in the message, so an error can no longer echo the content of a host the caller chose
  - Requests to user supplied URLs (connection tests, OIDC discovery, ntfy, Gotify, Apprise and webhook notifications) refuse link local and cloud metadata addresses and no longer follow redirects; private networks stay allowed because mirroring to a LAN Gitea is the normal deployment
- Raised the devalue floor to 5.9.2 in the application and the documentation site (GHSA-9rgm-9g3h-6x36, denial of service through malformed input); both lockfiles resolve 5.9.4
- Raised the dependency floors for the advisories published on 2026-09-08: Astro 7.2.8 (remote code execution through AVIF image optimization, and an authorization bypass when stripping the configured base), @xmldom/xmldom 0.8.15 (eight parser and serializer issues), sharp 0.35.4 (libheif), svgo 4.1.0 (removeScripts sanitization) and js-yaml 4.3.2 (merge-key CPU use). Applied to both the application and the documentation site.

### Added
- List view for the Organizations page (#428)
  - A cards/list switch in the toolbar; the list shows one row per organization with its role, destination, repository counts, last mirrored time, status, the same actions as the cards and the source and destination links, so a few dozen organizations fit on one screen
  - The choice is remembered per browser, next to the theme and time format preferences
- Incremental issue and pull request sync (#449)
  - After a complete pass, the issues and pull request passes ask GitHub only for items updated since the last one (with a 10 minute margin), so comments, pull request details, commits and files are fetched only for what changed instead of for every item on every sync
  - The watermark is stored per repository in the metadata state and only moves when a pass finishes with no failed item
  - A full pass still runs when the last one is older than 7 days, when the destination has no mirrored issues or pull requests, and after Reset metadata
- Releases mirror from Gitea and Forgejo sources, Codeberg included (#440)
  - The release mirror lists releases through the repository's own source instead of always through the GitHub API, and keeps the same release limit, asset limit, per-destination lock, tag check and retention pruning
  - Release assets are downloaded with the credentials of the host they live on, so a Gitea source uses its own token and a public one needs none
  - The release switch and its two limits are enabled for Gitea and Forgejo sources; GitLab stays code only
- Sync an organization that is already mirrored (#429)
  - The organization card menu gains Sync Organization for mirrored and failed organizations; the Mirror button only ever covered the first run
  - `POST /api/job/sync-org` re-discovers the organization's repositories from its source, mirrors the imported ones and syncs the mirrored, synced and failed ones, leaving rows another run owns alone; the organization is claimed before the response so two clicks cannot both start a run
- CSV export of repositories and organizations (#428)
  - `GET /api/repositories/export` and `GET /api/organizations/export` return the tables without the internal fields (ids, sync metadata, mirror option overrides); an Export CSV button sits in both toolbars and API keys work on both routes
- The login page can open on SSO (#438)
  - `AUTH_DEFAULT_METHOD=sso` sets the instance default, and each browser remembers the method it last signed in with; the new public `GET /api/auth/methods` tells the login page which methods exist and which to open on
- Public organizations without a source connection (#409)
  - The Add Organization dialog offers a Public only mode, the default when no source is connected: pick GitHub, GitLab or Gitea/Forgejo, optionally an instance URL, and the organization is imported anonymously
  - A tokenless source row is found or created for that provider and host and the organization is pinned to it, so attribution, locks, the scheduler and cleanup keep working per source
  - Anonymous GitHub clients keep the throttling and rate-limit backoff of authenticated ones, and the scheduler, per-repo mirror, retry, sync and recovery paths gate on the destination token instead of a source token
  - Sources with no username and no token are saved and shown as Public only, and the organizations and repositories pages work with no configured source
- Per-organization source selection for multi-source accounts
  - Organizations remember which source they import and mirror from; migration 0020 backfills the pin from each organization's repositories when they agree on one
  - Source picker in the add-organization dialog and on organization cards when more than one source is connected
  - `POST /api/sync/organization` persists `sourceId`, and `PATCH /api/organizations/:id` sets or clears it
  - The bulk import only clears a pin it created itself in the same run when a second source lists the same organization; pins set through the picker or the add dialog are kept
- Multi-source support: connect multiple source services per user (#375 follow-up)
  - Sources list on the Configuration page with add, edit and remove per source
  - Per-repository source attribution, with credentials resolved from each repository's own source
  - Per-source locking, discovery, auto import and cleanup
- Git LFS (Large File Storage) support for mirroring (#74)
  - New UI checkbox "Mirror LFS" in Mirror Options
  - Automatic LFS object transfer when enabled
  - Documentation for Gitea server LFS requirements
- Repository "ignored" status to skip specific repos from mirroring (#75)
  - Repositories can be marked as ignored to exclude from all operations
  - Scheduler automatically skips ignored repositories
- Enhanced error handling for all metadata mirroring operations
  - Individual try-catch blocks for issues, PRs, labels, milestones
  - Operations continue even if individual components fail
- Support for BETTER_AUTH_TRUSTED_ORIGINS environment variable (#63)
  - Enables access via multiple URLs (local IP + domain)
  - Comma-separated trusted origins configuration
  - Proper documentation for multi-URL access patterns
- Comprehensive fix report documentation

### Changed
- A new configuration starts with scheduling off unless `SCHEDULE_ENABLED=true`, `SCHEDULE_INTERVAL` or `GITEA_MIRROR_INTERVAL` turns it on, the same rule the environment loader uses; the built-in default schedule is the daily 22:00 clock schedule the automation card shows, so enabling from the card and the scheduler agree from the first save (#427)

### Fixed
- A GitHub rate limit no longer holds the scheduler lock until the reset (#437)
  - Every rate-limited request used to sleep for the full reset window inside the scheduler run, up to three times per request, so a large sync could keep the lock for hours while every tick logged "Scheduler is already running"; restarting was the only way out and the repositories that failed on the limit needed a manual retry
  - Waits of up to two minutes are still slept off in the request; a longer reset pauses the source instead, the run stops at the next batch or repository, the lock is released and the next run is moved to just after the reset
  - A repository whose attempt failed only because of the rate limit goes back to the status it had before, so the run after the reset picks it up on its own
- The `latest` Docker image tag no longer lags behind a release (#425)
  - A merge and the version bump that follows it land on main seconds apart; both built the image and both pushed `latest`, and on v3.36.1 the older build finished last, so `latest` carried 3.36.0 until the weekly rebuild replaced it
  - The workflow runs one build per ref at a time, `latest` is pushed only by a stable release tag build, main builds push `edge` and the short commit sha, and the security scan looks at the image the run just pushed
- The automation card shows the schedule that actually runs (#427)
  - A fresh install started with scheduling on and a plain 24 hour interval counted from first login, and the card, which only knows clock schedules, showed the 22:00 placeholder as if it were saved; the same misreport hit Docker installs with `GITEA_MIRROR_INTERVAL=8h`
  - When a plain interval is stored (from `SCHEDULE_INTERVAL`, `GITEA_MIRROR_INTERVAL` or an older version) the card says what runs and where it came from, and leaves frequency and start time unset until one is picked
  - The timezone chip shows the stored timezone instead of the browser's, and becomes a one-click switch to the browser timezone when the two differ
- Ignoring an organization stops its repositories from syncing (#429)
  - Ignore Organization only changed the organization row; its mirrored repositories kept syncing and rediscovery kept importing new ones for it
  - The organization's idle repositories are ignored with it (rows in flight or being deleted finish on their own) and restored when it is included again, mirrored ones as mirrored and the rest as imported; rediscovery skips ignored organizations
- Organization cards name the configured destination instead of always saying Gitea (#430)
- The Nix snippets in the README, NIX.md and the deployment guide import the module before enabling `services.gitea-mirror`, and put the flake input in `flake.nix` where it belongs (#426)
- Crash recovery no longer resumes a job that is still running
  - A job older than two hours was treated as interrupted even while it checkpointed every two minutes, so recovery started a second pass over the same repositories alongside the original; the age rule is gone and only a missing or stale checkpoint marks a job interrupted
  - Every completed item is now recorded in the job's checkpoint instead of one in every N, so a real resume skips exactly what was done; progress events are still throttled
  - Concurrent items completing at the same time could overwrite each other's checkpoint; job progress writes are serialized per job
  - A resumed job records a fresh start time
- The same upstream repository is no longer imported twice under two sources that point at the same host
  - Discovery decided what was new by (source, full name), so an organization pinned to a public-only github.com source and a personal github.com token source each inserted their own row for one repository, and both rows mirrored to the same destination in the same scheduler batch
  - Auto import, organization re-discovery and the two import endpoints now identify a repository by its host and full name whichever source lists it; the same name on a different host is still a separate repository
  - A scheduler pass mirrors or syncs one row per upstream repository and logs the duplicate rows it skips, so existing duplicates never run side by side
- A per-organization Mirror Destination equal to the organization's own name is kept instead of being dropped (#416)
  - The editor treated a typed value matching the organization name as "reset to default" and saved no override, which only holds under the preserve strategy; under single-org the default is the destination organization, so the repositories went there
  - The organization card now shows the default for the configured strategy in the preview, the placeholder, the helper text and the reset button, and marks any stored destination as custom
  - The repository destination column shows the organization's override as a repository's default, and pinning a repository to the value the strategy already produces is stored rather than discarded
  - Reset to Default on an organization card clears the override instead of saving the current value again
- Release assets are never duplicated on the destination (#417)
  - Gitea and Forgejo accept any number of attachments with the same name, so two mirror passes that overlapped on one repository both saw an asset as missing and both uploaded it, leaving two, three or five copies
  - Release reconciliation now runs one pass at a time per destination repository, keeps a single copy of each asset, and deletes surplus and stale copies before uploading anything
  - A sync no longer starts on a repository that is already being mirrored or synced, and the mirror path claims the repository in one statement instead of checking and then writing
  - Nothing is uploaded when the destination cannot say which assets a release already has, or when a stale copy could not be removed first
  - The next sync of an affected repository removes the surplus copies for every release that still gets its assets; releases that have dropped out of the newest-N window keep their duplicates until they are removed by hand
- Fixed metadata mirroring authentication errors (#68)
  - Changed field checking from `username` to `defaultOwner` in metadata functions
  - Added proper field validation for all metadata operations
- Fixed automatic mirroring scheduler issues (#72)
  - Improved interval parsing and error handling
- Fixed OIDC authentication 500 errors with Authentik (#73)
  - Added URL validation in Better Auth configuration
  - Prevented undefined URL errors in auth callback
- Fixed SSL certificate handling in Docker (#48)
  - NODE_EXTRA_CA_CERTS no longer gets overridden
  - Proper preservation of custom CA certificates
- Fixed reverse proxy base domain issues (#63)
  - Better handling of custom subdomains
  - Support for trusted origins configuration
- Fixed configuration persistence bugs (#49)
  - Config merging now preserves all fields
  - Retention period settings no longer reset
- Fixed sync failures with improved error handling (#51)
  - Comprehensive error wrapping for all operations
  - Better error messages and logging

### Improved
- Enhanced logging throughout metadata mirroring operations
  - Detailed success/failure messages for each component
  - Configuration details logged for debugging
- Better configuration state management
  - Proper merging of loaded configs with defaults
  - Preservation of user settings on refresh
- Updated documentation
  - Added LFS feature documentation
  - Updated README with new features
  - Enhanced CLAUDE.md with repository status definitions

## [3.7.1] - 2025-09-14

### Fixed
- Cleanup archiving for mirror repositories now works reliably (refs #84; awaiting user confirmation).
  - Gitea rejects names violating the AlphaDashDot rule; archiving a mirror now uses a sanitized rename strategy (`archived-<name>`), with a timestamped fallback on conflicts or validation errors.
  - Owner resolution during cleanup no longer uses the GitHub owner by mistake. It prefers `mirroredLocation`, falls back to computed Gitea owner via configuration, and verifies location with a presence check to avoid `GetUserByName` 404s.
- Repositories UI crash resolved when cleanup marked repos as archived.
  - Added `"archived"` to repository/job status enums, fixing Zod validation errors on the Repositories page.

### Changed
- Archiving logic for mirror repos is non-destructive by design: data is preserved, repo is renamed with an archive marker, and mirror interval is reduced (best‑effort) to minimize sync attempts.
- Cleanup service updates DB to `status: "archived"` and `isArchived: true` on successful archive path.

### Notes
- This release addresses the scenario where a GitHub source disappears (deleted/banned), ensuring Gitea backups are preserved even when using `CLEANUP_DELETE_IF_NOT_IN_GITHUB=true` with `CLEANUP_ORPHANED_REPO_ACTION=archive`.
- No database migration required.

## [3.2.6] - 2025-08-09

### Fixed
- Added missing release asset mirroring functionality (APK, ZIP, Binary files)
- Release assets (attachments) are now properly downloaded from GitHub and uploaded to Gitea
- Fixed missing metadata component configuration checks

### Added
- Full support for mirroring release assets/attachments
- Debug logging for metadata component configuration to help troubleshoot mirroring issues
- Download and upload progress logging for release assets

### Improved
- Enhanced release mirroring to include all associated binary files and attachments
- Better visibility into which metadata components are enabled/disabled
- More detailed logging during the release asset transfer process

### Notes
This patch adds the missing functionality to mirror release assets (APK, ZIP, Binary files, etc.) that was reported in Issue #68. Previously only release metadata was being mirrored, now all attachments are properly transferred to Gitea.

## [3.2.5] - 2025-08-09

### Fixed
- Fixed critical authentication issue in releases mirroring that was still using encrypted tokens
- Added missing repository existence check for releases mirroring function
- Fixed "user does not exist [uid: 0]" error specifically affecting GitHub releases synchronization

### Improved
- Enhanced releases mirroring with duplicate detection to avoid errors on re-runs
- Better error handling and logging for release operations with [Releases] prefix
- Added individual release error handling to continue mirroring even if some releases fail

### Notes
This patch completes the authentication fixes started in v3.2.4, specifically addressing the releases mirroring function that was accidentally missed in the previous update.

## [3.2.4] - 2025-08-09

### Fixed
- Fixed critical authentication issue causing "user does not exist [uid: 0]" errors during metadata mirroring (Issue #68)
- Fixed inconsistent token handling across Gitea API calls
- Fixed metadata mirroring functions attempting to operate on non-existent repositories
- Fixed organization creation failing silently without proper error messages

### Added
- Pre-flight authentication validation for all Gitea operations
- Repository existence verification before metadata mirroring
- Graceful fallback to user account when organization creation fails due to permissions
- Authentication validation utilities for debugging configuration issues
- Diagnostic test scripts for troubleshooting authentication problems

### Improved
- Enhanced error messages with specific guidance for authentication failures
- Better identification and logging of permission-related errors
- More robust organization creation with retry logic and better error handling
- Consistent token decryption across all API operations
- Clearer error reporting for metadata mirroring failures

### Security
- Fixed potential exposure of encrypted tokens in API calls
- Improved token handling to ensure proper decryption before use

## [3.2.0] - 2025-07-31

### Fixed
- Fixed Zod validation error in activity logs by correcting invalid "success" status values to "synced"
- Resolved activity fetch API errors that occurred after mirroring operations

### Changed
- Improved error handling and validation for mirror job status tracking
- Enhanced reliability of organization creation and mirroring processes

### Internal
- Consolidated Gitea integration modules for better maintainability
- Improved test coverage for mirror operations

## [3.1.1] - 2025-07-30

### Fixed
- Various bug fixes and stability improvements

## [3.1.0] - 2025-07-21

### Added
- Support for GITHUB_EXCLUDED_ORGS environment variable to filter out specific organizations during discovery
- New textarea UI component for improved form inputs in configuration

### Fixed
- Fixed test failures related to mirror strategy configuration location
- Corrected organization repository routing logic for different mirror strategies
- Fixed starred repositories organization routing bug
- Resolved SSO and OIDC authentication issues

### Improved
- Enhanced organization configuration for better repository routing control
- Better handling of mirror strategies in test suite
- Improved error handling in authentication flows

## [3.0.0] - 2025-07-17

### 🔴 Breaking Changes
- **Authentication System Overhaul**: Migrated from JWT to Better Auth session-based authentication
- **Login Method Changed**: Users now log in with email instead of username
- **Environment Variables**: `JWT_SECRET` renamed to `BETTER_AUTH_SECRET`, new `BETTER_AUTH_URL` required
- **API Endpoints**: Authentication endpoints moved from `/api/auth/login` to `/api/auth/[...all]`

### Added
- **Token Encryption**: All GitHub and Gitea tokens now encrypted with AES-256-GCM
- **SSO/OIDC Support**: Enterprise authentication with OAuth providers (Google, Azure AD, Okta, Authentik, etc.)
- **Header Authentication**: Support for reverse proxy authentication headers (Authentik, Authelia, Traefik Forward Auth)
- **OAuth Provider**: Gitea Mirror can act as an OIDC provider for other applications
- **Automated Migration**: Docker containers auto-migrate from v2 to v3
- **Session Management**: Improved security with session-based authentication
- **Database Migration System**: Drizzle Kit for better schema management
- **Zod v4 Compatibility**: Updated to Zod v4 for schema validation

### Improved
- **Security**: Enhanced error handling and security practices throughout
- **Documentation**: Comprehensive migration guide for v2 to v3 upgrade
- **User Management**: Better Auth provides improved user lifecycle management
- **Database Schema**: Optimized with proper indexes and relationships
- **Password Hashing**: Using bcrypt via Better Auth for secure password storage

### Fixed
- Mirroring issues for starred repositories
- Various security vulnerabilities in authentication system
- Improved error handling across all API endpoints

### Migration Required
- All users must re-authenticate after upgrade
- Existing tokens will be automatically encrypted
- Database schema updates applied automatically
- See [Migration Guide](MIGRATION_GUIDE.md) for detailed instructions

## [2.22.0] - 2025-07-07

### Added
- Comprehensive mobile and responsive design support across the entire application
- New drawer UI component for enhanced mobile navigation
- Mobile-specific layouts for major components (ActivityLog, Header, Organization, Repository)
- Mobile screenshots in documentation showcasing responsive design

### Improved
- Enhanced mobile user experience with optimized layouts for smaller screens
- Updated organization list cards with better mobile responsiveness
- Better touch interaction support throughout the application

### Fixed
- Type definition issues resolved
- Removed unnecessary console.log statements

### Documentation
- Updated README with mobile usage instructions and screenshots
- Added mobile-specific documentation sections

## [2.20.1] - 2025-07-07

### Fixed
- Fixed mixed mode organization strategy not persisting after page refresh
  - Added missing "mixed" case handler in GiteaConfigForm component
  - Enhanced getMirrorStrategy function to properly detect mixed mode configuration
- Updated dependencies to latest versions

## [2.20.0] - 2025-07-07

### Changed
- **BREAKING**: Repository moved from `arunavo4/gitea-mirror` to `RayLabsHQ/gitea-mirror`
- Docker images now hosted at `ghcr.io/raylabshq/gitea-mirror`
- Updated all repository references and links to new organization
- License changed from MIT to GNU General Public License v3.0

### Fixed
- Updated GitHub API endpoint for version checking to use new repository location
- Corrected all documentation references to point to RayLabsHQ organization

### Security
- Removed test security script after confirming vulnerability resolution
- Updated base Docker image to version 1.2.18-alpine

### Documentation
- Added repository migration notice in README
- Updated quickstart guide with new repository URLs
- Updated LXC deployment documentation with new repository location

## [2.18.0] - 2025-06-24

### Added
- Fourth organization strategy "Mixed Mode" that combines aspects of existing strategies
  - Personal repositories go to a single configurable organization
  - Organization repositories preserve their GitHub organization structure
- "Override Options" info button in Organization Strategy component explaining customization features
  - Organization overrides via edit buttons on organization cards
  - Repository overrides via inline destination editor
  - Starred repositories behavior and priority hierarchy

### Improved
- Simplified mixed strategy implementation to reuse existing database fields
- Enhanced organization strategy UI with comprehensive override documentation
- Better visual indicators for the new mixed strategy with orange color theme

## [2.17.0] - 2025-06-24

### Added
- Custom destination control for individual repositories with inline editing
- Organization-level destination overrides with visual destination editor
- Personal repositories organization override configuration option
- Visual indicators for starred repositories (⭐ icon) in repository list
- Repository-level destination override API endpoint
- Destination customization priority hierarchy system
- "View on Gitea" buttons for organizations with smart tooltip states

### Changed
- Enhanced repository table with destination column showing both GitHub org and Gitea destination
- Updated organization cards to display custom destinations with visual indicators
- Improved getGiteaRepoOwnerAsync to support repository-level destination overrides

### Improved
- Better visual feedback for custom destinations with badges and inline editing
- Enhanced user experience with hover-based edit buttons
- Comprehensive destination customization documentation in README

## [2.16.3] - 2025-06-20

### Added
- Custom 404 error page with helpful navigation links
- HoverCard components for better UX in configuration forms

### Improved
- Replaced popover components with hover cards for information tooltips
- Enhanced user experience with responsive hover interactions

## [2.16.2] - 2025-06-17

### Added
- Bulk actions for repository management with selection support

### Improved
- Enhanced organization card display with status badges and improved layout

## [2.16.1] - 2025-06-17

### Improved
- Improved repository owner handling and mirror strategy in Gitea integration
- Updated label for starred repositories organization for consistency

## [2.16.0] - 2025-06-17

### Added
- Enhanced OrganizationConfiguration component with improved layout and metadata options
- New GitHubMirrorSettings component with better organization and flexibility
- Enhanced starred repositories content selection and improved layout

### Improved
- Enhanced configuration interface layout and spacing across multiple components
- Streamlined OrganizationStrategy component with cleaner imports and better organization
- Improved responsive layout for larger screens in configuration forms
- Better icon usage and clarity in configuration components
- Enhanced tooltip descriptions and component organization
- Improved version comparison logic in health API
- Enhanced issue mirroring logic for starred repositories

### Fixed
- Fixed mirror to single organization functionality
- Resolved organization strategy layout issues
- Cleaned up unused imports across multiple components

### Refactored
- Simplified component structures by removing unused imports and dependencies
- Enhanced layout flexibility in GitHubConfigForm and GiteaConfigForm components
- Improved component organization and code clarity
- Removed ConnectionsForm and useMirror hook for better code organization

## [2.14.0] - 2025-06-17

### Added
- Enhanced UI components with @radix-ui/react-accordion dependency for improved configuration interface

### Fixed
- Mirror strategies now properly route repositories based on selected strategy
- Starred repositories now correctly go to the designated starred repos organization
- Organization routing for single-org and flat-user strategies

### Improved
- Documentation now explains all three mirror strategies (preserve, single-org, flat-user)
- Added detailed mirror strategy configuration guide
- Updated CLAUDE.md with mirror strategy architecture information
- Enhanced Docker Compose development configuration

## [2.13.2] - 2025-06-15

### Improved
- Enhanced documentation design and layout
- Updated README with improved formatting and content

## [2.13.1] - 2025-06-15

### Added
- Docker Hub authentication for Docker Scout security scanning
- Comprehensive Docker workflow consolidation with build, push & security scan

### Improved
- Enhanced CI/CD pipeline reliability with better error handling
- Updated Bun base image to latest version for improved security
- Migrated from Trivy to Docker Scout for more comprehensive security scanning
- Enhanced Docker workflow with wait steps for image availability

### Fixed
- Docker Scout action integration issues and image reference problems
- Workflow reliability improvements with proper error handling
- Security scanning workflow now continues on security issues without failing the build

### Changed
- Updated package dependencies to latest versions
- Consolidated multiple Docker workflows into single comprehensive workflow
- Enhanced security scanning with Docker Scout integration

## [2.13.0] - 2025-06-15

### Added
- Enhanced Configuration Interface with collapsible components and improved organization strategy UI
- Wiki Mirroring Support in configuration settings
- Auto-Save Functionality for all config forms, eliminating manual save buttons
- Live Refresh functionality with configuration status hooks and enhanced UI components
- Enhanced API Config Handling with mapping functions for UI and database structures
- Secure Error Responses with createSecureErrorResponse for consistent error handling
- Automatic Database Cleanup feature with configuration options and API support
- Enhanced Job Recovery with improved database schema and recovery mechanisms
- Fork tags to repository UI and enhanced organization cards with repository breakdown
- Skeleton loaders and better loading state management across the application

### Improved
- Navigation context and component loading states across the application
- Card components alignment and styling consistency
- Error logging and structured error message parsing
- HTTP client standardization across the application
- Database initialization and management processes
- Visual consistency with updated icons and custom logo integration

### Fixed
- Repository mirroring status inconsistencies
- Organizations getting stuck on mirroring status when empty
- JSON parsing errors and improved error handling
- Broken documentation links in README
- Various UI contrast and alignment issues

### Changed
- Migrated testing framework to Bun and updated test configurations
- Implemented graceful shutdown and enhanced job recovery capabilities
- Replaced SiGitea icons with custom logo
- Updated various dependencies for improved stability and performance

## [2.12.0] - 2025-01-27

### Fixed
- Fixed SQLite "no such table: mirror_jobs" error during application startup
- Implemented automatic database table creation during database initialization
- Resolved database schema inconsistencies between development and production environments

### Improved
- Enhanced database initialization process with automatic table creation and indexing
- Added comprehensive error handling for database table creation
- Integrated database repair functionality into application startup for better reliability

## [2.5.3] - 2025-05-22

### Added
- Enhanced JWT_SECRET handling with auto-generation and persistence for improved security
- Updated Proxmox LXC deployment instructions and replaced deprecated script

## [2.5.2] - 2024-11-22

### Fixed
- Fixed version information in health API for Docker deployments by setting npm_package_version environment variable in entrypoint script

## [2.5.1] - 2024-10-01

### Fixed
- Fixed Docker entrypoint script to prevent unnecessary `bun install` on container startup
- Removed redundant dependency installation in Docker containers for pre-built images
- Fixed "PathAlreadyExists" errors during container initialization

### Changed
- Improved database initialization in Docker entrypoint script
- Added additional checks for TypeScript versions of database management scripts

## [2.5.0] - 2024-09-15

Initial public release with core functionality:

### Added
- GitHub to Gitea repository mirroring
- User authentication and management
- Dashboard with mirroring statistics
- Configuration management for mirroring settings
- Support for organization mirroring
- Automated mirroring with configurable schedules
- Docker multi-architecture support (amd64, arm64)
- LXC container deployment scripts
