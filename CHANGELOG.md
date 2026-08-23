# Changelog

All notable changes to the Gitea Mirror project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Mirror Matrix / Switchboard: sync repositories between arbitrary source and target servers
  - New **Servers** sidebar section with server settings (GitHub, GitLab, Gitea, Forgejo, plain Git) and connection testing
  - New **Flow / Matrix** view for defining source → target mirror pairs (one-way `=>` and two-way `<=>`) with per-pair enable toggle
  - Pair settings modal: repository selection, organization structure, destructive update protection, and capability-gated mirror content options
  - New `servers` and `mirror_pairs` tables with automatic migration of existing GitHub/Gitea configs
  - New API routes: `/api/servers` (CRUD + connection test) and `/api/matrix` (CRUD + enabled toggle)
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

### Fixed
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
