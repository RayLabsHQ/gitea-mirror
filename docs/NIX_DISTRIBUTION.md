# Nix packaging

Maintainer notes for the Nix flake. The user guide is the [Nix and NixOS section](https://gitea-mirror.raylabs.io/docs/deployment/#nix-and-nixos) on the website.

## What the flake provides

`flake.nix` builds from source with [bun2nix](https://github.com/nix-community/bun2nix) and follows `nixos-unstable`.

| Output | What it is |
| --- | --- |
| `packages.<system>.default`, `packages.<system>.gitea-mirror` | The app, with the `gitea-mirror` wrapper and the `gitea-mirror-db` helper |
| `nixosModules.default` | The `services.gitea-mirror` module: a hardened systemd service plus a health check timer |
| `overlays.default` | Adds `pkgs.gitea-mirror` |
| `devShells.default` | Bun, SQLite, OpenSSL and bun2nix for development (`nix develop`, or direnv with `.envrc`) |

The wrapper keeps its data in `DATA_DIR` (default `~/.local/share/gitea-mirror`), generates the two secrets there on first start, and runs the env config loader, startup recovery and the repository repair before starting the server. Because the store is read-only, it runs from `$DATA_DIR/.workdir`, a folder of symlinks into the store that is rebuilt on every start.

There is no binary cache of our own: users build locally, and `flake.lock` keeps the build reproducible.

## bun.nix

`bun.nix` pins every package in `bun.lock` for the Nix build. After any change to `bun.lock`, regenerate it and commit the result:

```bash
nix run github:nix-community/bun2nix -- -o bun.nix
```

Without Nix, build bun2nix with `cargo install --git https://github.com/nix-community/bun2nix bun2nix --locked` and run `bun2nix -o bun.nix`.

CI fails when the committed `bun.nix` does not match `bun.lock`.

## CI

`.github/workflows/nix-build.yml` runs on ubuntu-latest, with Magic Nix Cache for the GitHub Actions cache. It runs for pushes to `main` and `nix`, for `v*` tags, and for pull requests to `main`, but only when `flake.nix`, `flake.lock`, `bun.nix`, `bun.lock`, `package.json` or the workflow itself change. It:

1. Regenerates `bun.nix` and fails if it differs from the committed one.
2. Runs `nix flake check` and `nix flake show`.
3. Runs `nix build`, on `main` and on tags only.

## Versions

The package version in `flake.nix` is hardcoded and still says `3.14.1`. Release bumps touch `package.json` and `helm/gitea-mirror/Chart.yaml` only, so `nix profile list` shows the wrong version. Reading it from `package.json` would fix that.

Users pin a release with its tag:

```bash
nix run github:RayLabsHQ/gitea-mirror/vX.Y.Z
```

## Known issues

- `gitea-mirror-db` does not work: it changes into the read-only store, and `scripts/manage-db.ts` looks for the database in `./data` instead of `DATA_DIR` or `DATABASE_URL`.

## Later

Submitting the package to nixpkgs would let users install it without the flake. It would need the version fix above and a release process that updates the nixpkgs package.
