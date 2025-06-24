# Changelog

All notable changes to the Gitea Mirror project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.0-beta.1] - TBD

### ⚠️ BREAKING CHANGES
- Complete database management rewrite using Drizzle migrations
- Removed manual database initialization scripts
- Changed database initialization process
- Minimum Bun version 1.2.9 required

### Added
- Proper Drizzle migration system with version tracking
- Automated schema migrations on startup
- Database migration history tracking
- Type-safe schema definitions
- `drizzle-kit` integration for database management
- Migration script for upgrading from v2.x

### Changed
- All database schema now defined in `/src/lib/db/schema.ts`
- Database initialization uses Drizzle migrations
- Consolidated all table definitions in one place
- Improved type safety with inferred types from schema

### Removed
- Manual SQL table creation in multiple files
- `manage-db.ts` script (replaced by migrations)
- Raw SQL from docker-entrypoint.sh
- Manual column checking and migration functions

### Migration Guide
1. Ensure you're on v2.19.1 before upgrading
2. Create a backup of your database
3. Run `bun scripts/migrate-v2-to-v3.ts`
4. Update to v3.0.0
5. Migrations will run automatically on startup

## [2.19.1] - 2025-06-24

### Fixed
- Fixed "jsxDEV is not a function" error in production builds by ensuring NODE_ENV=production is set
- Fixed upgrade issue where existing installations (v2.16.3 and earlier) would incorrectly show setup wizard
- Added automatic migration for auth_config table when upgrading from pre-v2.19.0 versions
- Added fix-v2.19-upgrade.sh script to help users manually fix upgrade issues

### Changed
- Updated build commands to explicitly set NODE_ENV=production
- Updated Dockerfile to set NODE_ENV during build stage
- Enhanced migration system to handle auth_config creation for existing users

## [2.19.0] - 2025-06-24

### Added
- UI-based authentication configuration wizard for initial setup
- Admin settings page for managing authentication configuration
- Database storage for authentication settings (auth_configs table)
- Setup wizard accessible at `/setup` for first-time configuration
- Real-time authentication method switching without restart
- Visual configuration forms for OIDC and Forward Auth
- Configuration testing before saving changes
- Migration guide for existing users
- Support for multiple authentication methods: Local, OIDC/SSO, and Forward Auth
- JWKS utilities for JWT validation
- Comprehensive authentication documentation

### Changed
- Authentication can now be configured via UI in addition to environment variables
- UI configuration takes precedence over environment variables
- Docker compose files updated to reflect optional auth environment variables
- Documentation updated to emphasize UI-based configuration

### Improved
- Better user experience for non-technical users setting up SSO
- Authentication configuration no longer requires editing configuration files
- Clearer documentation about configuration precedence
- Environment variables now serve as fallback/pre-configuration option
- Enhanced security with proper OIDC token validation
- Async validation for forward authentication

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
