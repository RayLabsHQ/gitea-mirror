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
nix run github:RayLabsHQ/gitea-mirror/v3.8.11
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

### Method 2: Binary Cache (Recommended)

Pre-build packages and cache them so users download binaries instead of building:

#### Setup: Cachix (Free for Public Projects)

1. **Create account:** https://cachix.org/
2. **Create cache:** `gitea-mirror` (public)
3. **Add secret to GitHub:** `Settings → Secrets → CACHIX_AUTH_TOKEN`
4. **GitHub Actions builds automatically** (see `.github/workflows/nix-build.yml`)

#### User Experience:

```bash
# First time: Configure cache
cachix use gitea-mirror

# Or add to nix.conf:
# substituters = https://cache.nixos.org https://gitea-mirror.cachix.org
# trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY= gitea-mirror.cachix.org-1:YOUR_KEY_HERE

# Then use normally - downloads pre-built binaries!
nix run github:RayLabsHQ/gitea-mirror
```

**Pros:**
- Fast installation (no compilation)
- Reduced bandwidth/CPU for users
- Professional experience

**Cons:**
- Requires Cachix account (free for public)
- Requires CI setup

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

### Phase 2: Binary Cache (Recommended Next)

Set up Cachix for faster installs:

1. Create Cachix cache
2. Add `CACHIX_AUTH_TOKEN` secret to GitHub
3. Workflow already created in `.github/workflows/nix-build.yml`
4. Add instructions to docs

### Phase 3: Version Releases (Optional)

Tag releases for version pinning:

```bash
git tag v3.8.11
git push origin v3.8.11

# Users can then pin:
nix run github:RayLabsHQ/gitea-mirror/v3.8.11
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

#### Option 2: With Binary Cache (Faster)

```bash
# One-time setup
cachix use gitea-mirror

# Then install (downloads pre-built binary)
nix profile install github:RayLabsHQ/gitea-mirror
```

#### Option 3: Pin to Specific Version

```bash
# Pin to git tag
nix run github:RayLabsHQ/gitea-mirror/v3.8.11

# Pin to commit
nix run github:RayLabsHQ/gitea-mirror/abc123def

# Lock in flake.nix
inputs.gitea-mirror.url = "github:RayLabsHQ/gitea-mirror/v3.8.11";
```

#### Option 4: NixOS Configuration

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    gitea-mirror.url = "github:RayLabsHQ/gitea-mirror";
    # Or pin to version:
    # gitea-mirror.url = "github:RayLabsHQ/gitea-mirror/v3.8.11";
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

### Cachix Not Working

1. **Verify cache exists:** https://gitea-mirror.cachix.org
2. **Check GitHub secret:** `CACHIX_AUTH_TOKEN` is set
3. **Review workflow logs:** Ensure build + push succeeded

### Version Pinning Not Working

```bash
# Verify tag exists
git tag -l

# Ensure tag is pushed
git ls-remote --tags origin

# Test specific tag
nix run github:RayLabsHQ/gitea-mirror/v3.8.11
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
| Cachix | 5 min | Fast (binary) | Free (public) | Medium |
| nixpkgs | Hours/days | Fast (binary) | Free | High |
| Self-hosted | 30+ min | Fast (binary) | Server cost | Low |

**Recommendation:** Start with **Direct GitHub** (works now), add **Cachix** for better UX (5 min), consider **nixpkgs** later for maximum reach.

---

## Resources

- [Nix Flakes Documentation](https://nixos.wiki/wiki/Flakes)
- [Cachix Documentation](https://docs.cachix.org/)
- [nixpkgs Contributing Guide](https://github.com/NixOS/nixpkgs/blob/master/CONTRIBUTING.md)
- [Nix Binary Cache Setup](https://nixos.org/manual/nix/stable/package-management/binary-cache-substituter.html)
