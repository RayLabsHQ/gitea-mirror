# gitea-mirror (Helm Chart)

Deploy **gitea-mirror** to Kubernetes using Helm. The chart packages a Deployment, Service, optional Ingress or Gateway API HTTPRoutes, ConfigMap and Secret, a PVC (optional), and an optional ServiceAccount.

- **Chart name:** `gitea-mirror`
- **Type:** `application`
- **App version:** `3.7.2` (default image tag, can be overridden)

---

## Prerequisites

- Kubernetes 1.23+
- Helm 3.8+
- (Optional) Gateway API (v1) if you plan to use `route.*` HTTPRoutes, see https://github.com/kubernetes-sigs/gateway-api/
- (Optional) An Ingress controller if you plan to use `ingress.*`

---

## Quick start

From the repo root (chart path: `helm/gitea-mirror`):

```bash
# Create a namespace (optional)
kubectl create namespace gitea-mirror

# Install with minimal required secrets/values
helm upgrade --install gitea-mirror ./helm/gitea-mirror   --namespace gitea-mirror   --set "gitea-mirror.github.username=<your-gh-username>"   --set "gitea-mirror.github.token=<your-gh-token>"   --set "gitea-mirror.gitea.url=https://gitea.example.com"   --set "gitea-mirror.gitea.token=<your-gitea-token>"
```

The default Service is `ClusterIP` on port `8080`. You can expose it via Ingress or Gateway API; see below.

---

## Upgrading

Standard Helm upgrade:

```bash
helm upgrade gitea-mirror ./helm/gitea-mirror -n gitea-mirror
```

If you change persistence settings or storage class, a rollout may require PVC recreation.

---

## Uninstalling

```bash
helm uninstall gitea-mirror -n gitea-mirror
```

If you enabled persistence with a PVC the data may persist; delete the PVC manually if you want a clean slate.

---

## Configuration

### Global image & pod settings

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `image.registry` | string | `ghcr.io` | Container registry. |
| `image.repository` | string | `raylabshq/gitea-mirror` | Image repository. |
| `image.tag` | string | `""` | Image tag; when empty, uses the chart `appVersion` (`3.7.2`). |
| `image.pullPolicy` | string | `IfNotPresent` | K8s image pull policy. |
| `imagePullSecrets` | list | `[]` | Image pull secrets. |
| `podSecurityContext.runAsUser` | int | `1001` | UID. |
| `podSecurityContext.runAsGroup` | int | `1001` | GID. |
| `podSecurityContext.fsGroup` | int | `1001` | FS group. |
| `podSecurityContext.fsGroupChangePolicy` | string | `OnRootMismatch` | FS group change policy. |
| `nodeSelector` / `tolerations` / `affinity` / `topologySpreadConstraints` | — | — | Standard scheduling knobs. |
| `extraVolumes` / `extraVolumeMounts` | list | `[]` | Append custom volumes/mounts. |
| `priorityClassName` | string | `""` | Optional Pod priority class. |

### Deployment

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `deployment.port` | int | `8080` | Container port & named `http` port. |
| `deployment.strategy.type` | string | `Recreate` | Update strategy (`Recreate` or `RollingUpdate`). |
| `deployment.strategy.rollingUpdate.maxUnavailable/maxSurge` | string/int | — | Used when `type=RollingUpdate`. |
| `deployment.env` | list | `[]` | Extra environment variables. |
| `deployment.resources` | map | `{}` | CPU/memory requests & limits. |
| `deployment.terminationGracePeriodSeconds` | int | `60` | Grace period. |
| `livenessProbe.*` | — | enabled, `/api/health` | Liveness probe (HTTP GET to `/api/health`). |
| `readinessProbe.*` | — | enabled, `/api/health` | Readiness probe. |
| `startupProbe.*` | — | enabled, `/api/health` | Startup probe. |

> The Pod mounts a volume at `/app/data` (PVC or `emptyDir` depending on `persistence.enabled`).

### Service

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `service.type` | string | `ClusterIP` | Service type. |
| `service.port` | int | `8080` | Service port. |
| `service.clusterIP` | string | `None` | ClusterIP (only when `type=ClusterIP`). |
| `service.externalTrafficPolicy` | string | `""` | External traffic policy (LB). |
| `service.loadBalancerIP` | string | `""` | LoadBalancer IP. |
| `service.loadBalancerClass` | string | `""` | LoadBalancer class. |
| `service.annotations` / `service.labels` | map | `{}` | Extra metadata. |

### Ingress (optional)

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `ingress.enabled` | bool | `false` | Enable Ingress. |
| `ingress.className` | string | `""` | IngressClass name. |
| `ingress.hosts[0].host` | string | `mirror.example.com` | Hostname. |
| `ingress.tls` | list | `[]` | TLS blocks (secret name etc.). |
| `ingress.annotations` | map | `{}` | Controller-specific annotations. |

> The Ingress exposes `/` to the chart’s Service.

### Gateway API HTTPRoutes (optional)

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `route.enabled` | bool | `false` | Enable Gateway API HTTPRoutes. |
| `route.forceHTTPS` | bool | `true` | If true, create an HTTP route that redirects to HTTPS (301). |
| `route.domain` | list | `["mirror.example.com"]` | Hostnames. |
| `route.gateway` | string | `""` | Gateway name. |
| `route.gatewayNamespace` | string | `""` | Gateway namespace. |
| `route.http.gatewaySection` | string | `""` | SectionName for HTTP listener. |
| `route.https.gatewaySection` | string | `""` | SectionName for HTTPS listener. |
| `route.http.filters` / `route.https.filters` | list | `[]` | Additional filters. (Defaults add HSTS header on HTTPS.) |

### Persistence

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `persistence.enabled` | bool | `true` | Enable persistent storage. |
| `persistence.create` | bool | `true` | Create a PVC from the chart. |
| `persistence.claimName` | string | `gitea-mirror-storage` | PVC name. |
| `persistence.storageClass` | string | `""` | StorageClass to use. |
| `persistence.accessModes` | list | `["ReadWriteOnce"]` | Access modes. |
| `persistence.size` | string | `1Gi` | Requested size. |
| `persistence.volumeName` | string | `""` | Bind to existing PV by name (optional). |
| `persistence.annotations` | map | `{}` | PVC annotations. |

### ServiceAccount (optional)

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceAccount.create` | bool | `false` | Create a ServiceAccount. |
| `serviceAccount.name` | string | `""` | SA name (defaults to release fullname). |
| `serviceAccount.automountServiceAccountToken` | bool | `false` | Automount token. |
| `serviceAccount.annotations` / `labels` | map | `{}` | Extra metadata. |

---

## Application configuration (`gitea-mirror.*`)

These values populate a **ConfigMap** (non-secret) and a **Secret** (for tokens and sensitive fields). Environment variables from both are consumed by the container.

### Core

| Key | Default | Mapped env |
| --- | --- | --- |
| `gitea-mirror.nodeEnv` | `production` | `NODE_ENV` |
| `gitea-mirror.core.databaseUrl` | `file:data/gitea-mirror.db` | `DATABASE_URL` |
| `gitea-mirror.core.encryptionSecret` | `""` | `ENCRYPTION_SECRET` (Secret) |
| `gitea-mirror.core.betterAuthSecret` | `""` | `BETTER_AUTH_SECRET` |
| `gitea-mirror.core.betterAuthUrl` | `http://localhost:4321` | `BETTER_AUTH_URL` |
| `gitea-mirror.core.betterAuthTrustedOrigins` | `http://localhost:4321` | `BETTER_AUTH_TRUSTED_ORIGINS` |

### GitHub

| Key | Default | Mapped env |
| --- | --- | --- |
| `gitea-mirror.github.username` | `""` | `GITHUB_USERNAME` |
| `gitea-mirror.github.token` | `""` | `GITHUB_TOKEN` (Secret) |
| `gitea-mirror.github.type` | `personal` | `GITHUB_TYPE` |
| `gitea-mirror.github.privateRepositories` | `true` | `PRIVATE_REPOSITORIES` |
| `gitea-mirror.github.skipForks` | `false` | `SKIP_FORKS` |
| `gitea-mirror.github.skipStarredIssues` | `false` | `SKIP_STARRED_ISSUES` |
| `gitea-mirror.github.mirrorStarred` | `false` | `MIRROR_STARRED` |

### Gitea

| Key | Default | Mapped env |
| --- | --- | --- |
| `gitea-mirror.gitea.url` | `""` | `GITEA_URL` |
| `gitea-mirror.gitea.token` | `""` | `GITEA_TOKEN` (Secret) |
| `gitea-mirror.gitea.username` | `""` | `GITEA_USERNAME` |
| `gitea-mirror.gitea.organization` | `github-mirrors` | `GITEA_ORGANIZATION` |
| `gitea-mirror.gitea.visibility` | `public` | `GITEA_ORG_VISIBILITY` |

### Mirror options

| Key | Default | Mapped env |
| --- | --- | --- |
| `gitea-mirror.mirror.releases` | `true` | `MIRROR_RELEASES` |
| `gitea-mirror.mirror.wiki` | `true` | `MIRROR_WIKI` |
| `gitea-mirror.mirror.metadata` | `true` | `MIRROR_METADATA` |
| `gitea-mirror.mirror.issues` | `true` | `MIRROR_ISSUES` |
| `gitea-mirror.mirror.pullRequests` | `true` | `MIRROR_PULL_REQUESTS` |
| `gitea-mirror.mirror.starred` | _(see note above)_ | `MIRROR_STARRED` |

### Automation & cleanup

| Key | Default | Mapped env |
| --- | --- | --- |
| `gitea-mirror.automation.schedule_enabled` | `true` | `SCHEDULE_ENABLED` |
| `gitea-mirror.automation.schedule_interval` | `3600` | `SCHEDULE_INTERVAL` (seconds) |
| `gitea-mirror.cleanup.enabled` | `true` | `CLEANUP_ENABLED` |
| `gitea-mirror.cleanup.retentionDays` | `30` | `CLEANUP_RETENTION_DAYS` |

> **Secrets:** If you set `gitea-mirror.existingSecret` (name of an existing Secret), the chart will **not** create its own Secret and will reference yours instead. Otherwise it creates a Secret with `GITHUB_TOKEN`, `GITEA_TOKEN`, `ENCRYPTION_SECRET`.

---

## Exposing the service

### Using Ingress

```yaml
ingress:
  enabled: true
  className: "nginx"
  hosts:
    - host: mirror.example.com
  tls:
    - secretName: mirror-tls
      hosts:
        - mirror.example.com
```

This creates an Ingress routing `/` to the service on port `8080`.

### Using Gateway API (HTTPRoute)

```yaml
route:
  enabled: true
  domain: ["mirror.example.com"]
  gateway: "my-gateway"
  gatewayNamespace: "gateway-system"
  http:
    gatewaySection: "http"
  https:
    gatewaySection: "https"
    # Example extra filter already included by default: add HSTS header
```

If `forceHTTPS: true`, the chart emits an HTTP route that redirects to HTTPS with 301. An HTTPS route is always created when `route.enabled=true`.

---

## Persistence & data

By default, the chart provisions a PVC named `gitea-mirror-storage` with `1Gi` and mounts it at `/app/data`. To use an existing PV or tune storage, adjust `persistence.*` in `values.yaml`. If you disable persistence, an `emptyDir` will be used instead.

---

## Environment & health endpoints

The container listens on `PORT` (defaults to `deployment.port` = `8080`) and exposes `GET /api/health` for liveness/readiness/startup probes.

---

## Examples

### Minimal (tokens via chart-managed Secret)

```yaml
gitea-mirror:
  github:
    username: "gitea-mirror"
    token: "<gh-token>"
  gitea:
    url: "https://gitea.company.tld"
    token: "<gitea-token>"
```

### Bring your own Secret

```yaml
gitea-mirror:
  existingSecret: "gitea-mirror-secrets"
  github:
    username: "gitea-mirror"
  gitea:
    url: "https://gitea.company.tld"
```

Where `gitea-mirror-secrets` contains keys `GITHUB_TOKEN`, `GITEA_TOKEN`, `ENCRYPTION_SECRET`.

---

## Development

Lint the chart:

```bash
yamllint -c helm/gitea-mirror/.yamllint helm/gitea-mirror
```

Tweak probes, resources, and scheduling as needed; see `values.yaml`.

---

## License

This chart is part of the `RayLabsHQ/gitea-mirror` repository. See the repository for licensing details.
