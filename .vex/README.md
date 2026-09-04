# Vulnerability exceptions for the Docker image

This folder holds [OpenVEX](https://openvex.dev) statements for CVEs that
Docker Scout reports against the image but that the image cannot reach. Each
statement names the CVE, says why it does not apply, and points at the
upstream and Debian status so the reason can be checked later.

The statements are used in two places:

- The Docker Scout steps in `.github/workflows/docker-build.yml` pass
  `vex-location: .vex` together with `vex-author` and `only-vex-affected`, so
  the scan that feeds the Security tab leaves these CVEs out. Scout ignores
  statements from authors that are not listed; the default author filter only
  accepts `*@docker.com`.
- The `Dockerfile` copies `*.vex.json` into `/var/lib/db/` in the runner
  stage, so `docker scout cves ghcr.io/raylabshq/gitea-mirror:latest` shows
  the same result for anyone who scans the published image.

To check locally:

```bash
docker scout cves --vex-location .vex --vex-author developer@arunavoray.dev \
  --only-vex-affected ghcr.io/raylabshq/gitea-mirror:latest
```

## When to remove a statement

Delete the statement once the Debian package it covers is fixed in the base
image (the CVE disappears from the scan on its own), or once the reasoning no
longer holds, for example if the image starts running a setuid helper or a
different user model. Debian's status for a CVE is at
`https://security-tracker.debian.org/tracker/<CVE>`.

## Current statements

| File | CVEs | Package | Why |
| --- | --- | --- | --- |
| `util-linux-mount-nsenter.vex.json` | CVE-2026-78408, CVE-2026-78409, CVE-2026-78410 | util-linux 2.41.5-0+deb13u1 (trixie, no fix planned) | nsenter and setuid mount(8) are never used; the runner stage strips setuid bits and the app runs unprivileged. |
