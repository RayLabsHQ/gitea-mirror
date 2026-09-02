# Gitea Mirror Documentation

This folder contains engineering and operations references for the open-source Gitea Mirror project. Each guide focuses on the parts of the system that still require bespoke explanation beyond the in-app help and the main `README.md`.

## Available Guides

### Core workflow
- **[DEVELOPMENT_WORKFLOW.md](./DEVELOPMENT_WORKFLOW.md)** – Set up a local environment, run scripts, and understand the repo layout (app + marketing site).
- **[ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)** – Complete reference for every configuration flag supported by the app and Docker images.
- **[NIX_DEPLOYMENT.md](./NIX_DEPLOYMENT.md)** – User-facing deployment guide for Nix and NixOS.
- **[NIX_DISTRIBUTION.md](./NIX_DISTRIBUTION.md)** – Maintainer notes for packaging, releases, and distribution strategy.

### Reliability & recovery
- **[GRACEFUL_SHUTDOWN.md](./GRACEFUL_SHUTDOWN.md)** – How signal handling, shutdown coordination, and job persistence work in v3.
- **[RECOVERY_IMPROVEMENTS.md](./RECOVERY_IMPROVEMENTS.md)** – Deep dive into the startup recovery workflow and supporting scripts.

### Authentication
- **[SSO-OIDC-SETUP.md](./SSO-OIDC-SETUP.md)** – Configure OIDC/SSO providers through the admin UI.
- **[SSO_TESTING.md](./SSO_TESTING.md)** – Recipes for local and staging SSO testing (Google, Keycloak, mock providers).
- **[API.md](./API.md)** – Create API keys and call the app from scripts, CI pipelines and workflow tools.

### Destinations
- **[PUSH_TARGETS.md](./PUSH_TARGETS.md)** – GitHub and GitLab as destinations: how the push engine works, token scopes, disk usage, what is not mirrored.

If you are looking for customer-facing playbooks, see the MDX use cases under `www/src/pages/use-cases/`.

## Quick start for local development

```bash
git clone https://github.com/RayLabsHQ/gitea-mirror.git
cd gitea-mirror
bun run setup           # installs deps and seeds the SQLite DB
bun run dev             # starts the Astro/Bun app on http://localhost:4321
```

The first user you create locally becomes the administrator. All other configuration—GitHub owners, Gitea targets, scheduling, cleanup—is done through the **Configuration** screen in the UI.

## Contributing & support

- 🎯 Contribution guide: [../CONTRIBUTING.md](../CONTRIBUTING.md)
- 🐞 Issues & feature requests: <https://github.com/RayLabsHQ/gitea-mirror/issues>
- 💬 Discussions: <https://github.com/RayLabsHQ/gitea-mirror/discussions>
- 🔐 Security policy & advisories: <https://github.com/RayLabsHQ/gitea-mirror/security>
