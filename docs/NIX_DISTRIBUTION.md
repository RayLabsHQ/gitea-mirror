# Nix Package Distribution Guide

This guide explains how Gitea Mirror is distributed via Nix and how users can consume it.

## Distribution Methods

### Method 1: Direct GitHub Usage (Zero Infrastructure)

**No CI, releases, or setup needed!** Users can consume directly from GitHub:

```bash
# Latest from main branch
nix run --extra-experimental-features 'nix-command flakes' github:RayLabsHQ/gitea-mirror

# Pin to specific commit
nix run github:RayLabsHQ/gitea-mirror/abc123def

# Pin to git tag
nix run github:RayLabsHQ/gitea-mirror/vX.Y.Z
```

**How it works:**
1. Nix fetches the repository from GitHub
2. Nix reads `flake.nix` and `flake.lock`
3. Nix builds the package locally on the user's machine
4. Package is cached in `/nix/store` for reuse

**Pros:**
- Zero infrastructure needed
- Works immediately after pushing code
- Users always get reproducible builds

**Cons:**
- Users must build from source (slower first time)
- Requires build dependencies (Bun, etc.)

---

### Method 2: CI Build Caching

The GitHub Actions workflow uses **Magic Nix Cache** (by Determinate Systems) to cache builds:

- **Zero configuration required** - no accounts or tokens needed
- **Automatic** - CI workflow handles everything
- **Uses GitHub Actions cache** - fast, reliable, free

#### How It Works:

1. GitHub Actions builds the package on each push/PR
2. Build artifacts are cached in GitHub Actions cache
3. Subsequent builds reuse cached dependencies (faster CI)

Note: This caches CI builds. Users still build locally, but the flake.lock ensures reproducibility.

---

### Method 3: nixpkgs Submission (Official Distribution)

Submit to the official Nix package repository for maximum visibility.

#### Process:

1. **Prepare package** (already done with `flake.nix`)
2. **Test thoroughly**
3. **Submit PR to nixpkgs:** https://github.com/NixOS/nixpkgs

#### User Experience:

```bash
# After acceptance into nixpkgs
nix run nixpkgs#gitea-mirror

# NixOS configuration
environment.systemPackages = [ pkgs.gitea-mirror ];
```

**Pros:**
- Maximum discoverability (official repo)
- Trusted by Nix community
- Included in NixOS search
- Binary caching by cache.nixos.org

**Cons:**
- Submission/review process
- Must follow nixpkgs guidelines
- Updates require PRs

---

## Current Distribution Strategy

### Phase 1: Direct GitHub (Immediate) ✅

Already working! Users can:

```bash
nix run github:RayLabsHQ/gitea-mirror
```

### Phase 2: CI Build Validation ✅

GitHub Actions workflow validates builds on every push/PR:

- Uses Magic Nix Cache for fast CI builds
- Tests on both Linux and macOS
- No setup required - works automatically

### Phase 3: Version Releases (Optional)

Tag releases for version pinning:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z

# Users can then pin:
nix run github:RayLabsHQ/gitea-mirror/vX.Y.Z
```

### Phase 4: nixpkgs Submission (Long Term)

Once package is stable and well-tested, submit to nixpkgs.

---

## User Documentation

### For Users: How to Install

Add this to your `docs/NIX_DEPLOYMENT.md`:

#### Option 1: Direct Install (No Configuration)

```bash
# Run immediately
nix run --extra-experimental-features 'nix-command flakes' github:RayLabsHQ/gitea-mirror

# Install to profile
nix profile install --extra-experimental-features 'nix-command flakes' github:RayLabsHQ/gitea-mirror
```

#### Option 2: Pin to Specific Version

```bash
# Pin to git tag
nix run github:RayLabsHQ/gitea-mirror/vX.Y.Z

# Pin to commit
nix run github:RayLabsHQ/gitea-mirror/abc123def

# Lock in flake.nix
inputs.gitea-mirror.url = "github:RayLabsHQ/gitea-mirror/vX.Y.Z";
```

#### Option 3: NixOS Configuration

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    gitea-mirror.url = "github:RayLabsHQ/gitea-mirror";
    # Or pin to version:
    # gitea-mirror.url = "github:RayLabsHQ/gitea-mirror/vX.Y.Z";
  };

  outputs = { nixpkgs, gitea-mirror, ... }: {
    nixosConfigurations.your-host = nixpkgs.lib.nixosSystem {
      modules = [
        gitea-mirror.nixosModules.default
        {
          services.gitea-mirror = {
            enable = true;
            betterAuthUrl = "https://mirror.example.com";
            openFirewall = true;
          };
        }
      ];
    };
  };
}
```

---

## Maintaining the Distribution

### Releasing New Versions

```bash
# 1. Update version in package.json
vim package.json  # Update version field

# 2. Update flake.nix version (line 17)
vim flake.nix  # Update version = "X.Y.Z";

# 3. Commit changes
git add package.json flake.nix
git commit -m "chore: bump version to vX.Y.Z"

# 4. Create git tag
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z

# 5. GitHub Actions builds and caches automatically
```

Users can then pin to the new version:
```bash
nix run github:RayLabsHQ/gitea-mirror/vX.Y.Z
```

### Updating Flake Lock

The `flake.lock` file pins all dependencies. Update it periodically:

```bash
# Update all inputs
nix flake update

# Update specific input
nix flake lock --update-input nixpkgs

# Test after update
nix build
nix flake check

# Commit the updated lock file
git add flake.lock
git commit -m "chore: update flake dependencies"
git push
```

---

## Troubleshooting Distribution Issues

### Users Report Build Failures

1. **Check GitHub Actions:** Ensure CI is passing
2. **Test locally:** `nix flake check`
3. **Check flake.lock:** May need update if dependencies changed

### CI Cache Not Working

1. **Check workflow logs:** Review GitHub Actions for errors
2. **Clear cache:** GitHub Actions → Caches → Delete relevant cache
3. **Verify flake.lock:** May need `nix flake update` if dependencies changed

### Version Pinning Not Working

```bash
# Verify tag exists
git tag -l

# Ensure tag is pushed
git ls-remote --tags origin

# Test specific tag
nix run github:RayLabsHQ/gitea-mirror/vX.Y.Z
```

---

## Advanced: Custom Binary Cache

If you prefer self-hosting instead of Cachix:

### Option 1: S3-Compatible Storage

```nix
# Generate signing key
nix-store --generate-binary-cache-key cache.example.com cache-priv-key.pem cache-pub-key.pem

# Push to S3
nix copy --to s3://my-nix-cache?region=us-east-1 $(nix-build)
```

Users configure:
```nix
substituters = https://my-bucket.s3.amazonaws.com/nix-cache
trusted-public-keys = cache.example.com:BASE64_PUBLIC_KEY
```

### Option 2: Self-Hosted Nix Store

Run `nix-serve` on your server:

```bash
# On server
nix-serve -p 8080

# Behind nginx/caddy
proxy_pass http://localhost:8080;
```

Users configure:
```nix
substituters = https://cache.example.com
trusted-public-keys = YOUR_KEY
```

---

## Comparison: Distribution Methods

| Method | Setup Time | User Speed | Cost | Discoverability |
|--------|-----------|------------|------|-----------------|
| Direct GitHub | 0 min | Slow (build) | Free | Low |
| nixpkgs | Hours/days | Fast (binary) | Free | High |
| Self-hosted cache | 30+ min | Fast (binary) | Server cost | Low |

**Current approach:** Direct GitHub consumption with CI validation using Magic Nix Cache. Users build locally (reproducible via flake.lock). Consider **nixpkgs** submission for maximum reach once the package is mature.

---

## Resources

- [Nix Flakes Documentation](https://nixos.wiki/wiki/Flakes)
- [Magic Nix Cache](https://github.com/DeterminateSystems/magic-nix-cache-action)
- [nixpkgs Contributing Guide](https://github.com/NixOS/nixpkgs/blob/master/CONTRIBUTING.md)
- [Nix Binary Cache Setup](https://nixos.org/manual/nix/stable/package-management/binary-cache-substituter.html)
