# GitHub Workflows for Gitea Mirror

This directory contains GitHub Actions workflows that automate the build, test, and deployment processes for the Gitea Mirror application.

## Workflow Overview

| Workflow | File | Purpose |
|----------|------|---------|
| Astro Build and Test | `astro-build-test.yml` | Builds and tests the Astro application for all branches and PRs |
| Docker Build and Push | `docker-build.yml` | Builds and pushes Docker images only for the main branch |
| Docker Security Scan | `docker-scan.yml` | Scans Docker images for security vulnerabilities |

## Workflow Details

### Astro Build and Test (`astro-build-test.yml`)

This workflow runs on all branches and pull requests. It:

- Builds the Astro project
- Runs all tests
- Uploads build artifacts for potential use in other workflows

**When it runs:**
- On push to any branch (except changes to README.md and docs)
- On pull requests to any branch (except changes to README.md and docs)

**Key features:**
- Uses pnpm for dependency installation and Bun as the runtime
- Caches dependencies to speed up builds
- Uploads build artifacts for 7 days

### Docker Build and Push (`docker-build.yml`)

This workflow builds and pushes Docker images to GitHub Container Registry (ghcr.io), but only when changes are merged to the main branch.

**When it runs:**
- On push to the main branch
- On tag creation (v*)

**Key features:**
- Builds multi-architecture images (amd64 and arm64)
- Pushes images only on main branch, not for PRs
- Uses build caching to speed up builds
- Creates multiple tags for each image (latest, semver, sha)

### Docker Security Scan (`docker-scan.yml`)

This workflow scans Docker images for security vulnerabilities using Trivy.

**When it runs:**
- On push to the main branch that affects Docker-related files
- Weekly on Sunday at midnight (scheduled)

**Key features:**
- Scans for critical and high severity vulnerabilities
- Fails the build if vulnerabilities are found
- Ignores unfixed vulnerabilities

## CI/CD Pipeline Philosophy

Our CI/CD pipeline follows these principles:

1. **Fast feedback for developers**: The Astro build and test workflow runs on all branches and PRs to provide quick feedback.
2. **Efficient resource usage**: Docker images are only built when changes are merged to main, not for every PR.
3. **Security first**: Regular security scanning ensures our Docker images are free from known vulnerabilities.
4. **Multi-architecture support**: All Docker images are built for both amd64 and arm64 architectures.

## Adding or Modifying Workflows

When adding or modifying workflows:

1. Ensure the workflow follows the existing patterns
2. Test the workflow on a branch before merging to main
3. Update this README if you add a new workflow or significantly change an existing one
4. Consider the impact on CI resources and build times

## Troubleshooting

If a workflow fails:

1. Check the workflow logs in the GitHub Actions tab
2. Common issues include:
   - Test failures
   - Build errors
   - Docker build issues
   - Security vulnerabilities

For persistent issues, consider opening an issue in the repository.
