# docs/

User documentation lives on the website: **[gitea-mirror.raylabs.io/docs](https://gitea-mirror.raylabs.io/docs/)**, with its sources in [`www/src/pages/docs/`](../www/src/pages/docs/). Change those pages when behavior changes.

This folder holds notes for maintainers and contributors:

- [DEVELOPMENT_WORKFLOW.md](DEVELOPMENT_WORKFLOW.md): local setup, commands, tests, type checking and releases.
- [SHUTDOWN_AND_RECOVERY.md](SHUTDOWN_AND_RECOVERY.md): signals, stop timeouts, job recovery and the related scripts.
- [NIX_DISTRIBUTION.md](NIX_DISTRIBUTION.md): the Nix flake, `bun.nix` and the Nix CI.
- [SSO_TESTING.md](SSO_TESTING.md): testing SSO sign-in locally against Google, Keycloak or a mock provider.

The other files here are short pointers to the website, kept so old links keep working.

See also [CONTRIBUTING.md](../CONTRIBUTING.md) and [CLAUDE.md](../CLAUDE.md) in the repository root.
