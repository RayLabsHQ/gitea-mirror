# GitHub Workflows for Gitea Mirror

This directory contains GitHub Actions workflows that automate the build, test, and deployment processes for the Gitea Mirror application.

## Workflow Overview

| Workflow | File | Purpose |
|----------|------|---------|
| Astro Build and Test | `astro-build-test.yml` | Builds and tests the Astro application for all branches and PRs |
| Docker Build, Push & Security Scan | `docker-build.yml` | Builds, scans, and pushes Docker images |

## Workflow Details

### Astro Build and Test (`astro-build-test.yml`)

This workflow runs on all branches and pull requests. It:

- Builds the Astro project
- Runs all tests
- Uploads build artifacts for potential use in other workflows

**When it runs:**
- On push to any branch (except changes to README.md and docs)
- On pull requests to any branch (except changes to README.md and docs)

- Uses Bun for dependency installation
- Caches dependencies to speed up builds
- Uploads build artifacts for 7 days

### Docker Build, Push & Security Scan (`docker-build.yml`)

This workflow builds Docker images on pushes and pull requests, scans them, and pushes to GitHub Container Registry (ghcr.io) when permissions allow (main/tags and same-repo PRs).

**When it runs:**
- On push to the main branch
- On tag creation (v*)
- On pull requests (build + scan; push only for same-repo PRs)
- Weekly on Sunday at midnight (scheduled security scan)

**Key features:**
- Builds multi-architecture images (amd64 and arm64)
- Pushes images for main/tags and same-repo PRs
- Skips registry push for fork PRs (avoids package write permission failures)
- Uses build caching to speed up builds
- Creates multiple tags for each image (latest, semver, sha)
- Auto-syncs `package.json` version from `v*` tags during release builds
- Validates release tags use semver format before building
- After tag builds succeed, writes the same version back to `main/package.json`

**Security scanning:**
- Docker Scout runs on main/tag pushes, the weekly schedule, and same-repo PRs. It needs the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets, posts a PR comment, and uploads SARIF to the Security tab.
- Trivy runs on every PR, including forks. It needs no credentials and writes critical/high (fixable) findings to the job summary.
- Fork PRs cannot use Docker Scout because GitHub never exposes repository secrets to them. Do not "fix" that with `pull_request_target`; it would run untrusted PR code with the secrets available.
- Both scanners are informational and do not fail the build.

## CI/CD Pipeline Philosophy

Our CI/CD pipeline follows these principles:

1. **Fast feedback for developers**: The Astro build and test workflow runs on all branches and PRs to provide quick feedback.
2. **Efficient resource usage**: Docker images are built for every PR so they can be scanned, but only pushed for main, tags, and same-repo PRs.
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


### Helm Test (`helm-test.yml`)

This workflow run on the main branch and pull requests. it:
- Run yamllint to keep the formating unified
- Run helm template with different value files
