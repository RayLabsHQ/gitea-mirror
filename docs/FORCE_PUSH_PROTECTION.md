# Force-Push Protection

This document describes the smart force-push protection system introduced in gitea-mirror v3.11.0+.

## The Problem

GitHub repositories can be force-pushed at any time — rewriting history, deleting branches, or replacing commits entirely. When gitea-mirror syncs a force-pushed repo, the old history in Gitea is silently overwritten. Files, commits, and branches disappear with no way to recover them.

The original workaround (`backupBeforeSync: true`) created a full git bundle backup before **every** sync. This doesn't scale — a user with 100+ GiB of mirrors would need up to 2 TB of backup storage with default retention settings, even though force-pushes are rare.

## Solution: Smart Detection

Instead of backing up everything every time, the system detects force-pushes **before** they happen and only acts when needed.

### How Detection Works

Before each sync, the app compares branch SHAs between Gitea (the mirror) and GitHub (the source):

1. **Fetch branches from both sides** — lightweight API calls to get branch names and their latest commit SHAs
2. **Compare each branch**:
   - SHAs match → nothing changed, no action needed
   - SHAs differ → check if the change is a normal push or a force-push
3. **Ancestry check** — for branches with different SHAs, call GitHub's compare API to determine if the new SHA is a descendant of the old one:
   - **Fast-forward** (new SHA descends from old) → normal push, safe to sync
   - **Diverged** (histories split) → force-push detected
   - **404** (old SHA doesn't exist on GitHub anymore) → history was rewritten, force-push detected
   - **Branch deleted on GitHub** → flagged as destructive change

### What Happens on Detection

Depends on the configured strategy (see below):
- **Backup strategies** (`always`, `on-force-push`): create a git bundle snapshot, then sync
- **Block strategy** (`block-on-force-push`): halt the sync, mark the repo as `pending-approval`, wait for user action

### Fail-Open Design

If detection itself fails (GitHub rate limits, network errors, API outages), sync proceeds normally. Detection never blocks a sync due to its own failure. Individual branch check failures are skipped — one flaky branch doesn't affect the others.

## Backup Strategies

Configure via **Settings → GitHub Configuration → Destructive Update Protection**.

| Strategy | What It Does | Storage Cost | Best For |
|---|---|---|---|
| **Disabled** | No detection, no backups | Zero | Repos you don't care about losing |
| **Always Backup** | Snapshot before every sync (original behavior) | High | Small mirror sets, maximum safety |
| **Smart** (default) | Detect force-pushes, backup only when found | Near-zero normally | Most users — efficient protection |
| **Block & Approve** | Detect force-pushes, block sync until approved | Zero | Critical repos needing manual review |

### Strategy Details

#### Disabled

Syncs proceed without any detection or backup. If a force-push happens on GitHub, the mirror silently overwrites.

#### Always Backup

Creates a git bundle snapshot before every sync regardless of whether a force-push occurred. This is the legacy behavior (equivalent to the old `backupBeforeSync: true`). Safe but expensive for large mirror sets.

#### Smart (`on-force-push`) — Recommended

Runs the force-push detection before each sync. On normal days (no force-pushes), syncs proceed without any backup overhead. When a force-push is detected, a snapshot is created before the sync runs.

This gives you protection when it matters with near-zero cost when it doesn't.

#### Block & Approve (`block-on-force-push`)

Runs detection and, when a force-push is found, **blocks the sync entirely**. The repository is marked as `pending-approval` and excluded from future scheduled syncs until you take action:

- **Approve**: creates a backup first, then syncs (safe)
- **Dismiss**: clears the flag and resumes normal syncing (no backup)

Use this for repos where you want manual control over destructive changes.

## Additional Settings

These appear when any non-disabled strategy is selected:

### Snapshot Retention Count

How many backup snapshots to keep per repository. Oldest snapshots are deleted when this limit is exceeded. Default: **20**.

### Snapshot Directory

Where git bundle backups are stored. Default: **`data/repo-backups`**. Bundles are organized as `<directory>/<owner>/<repo>/<timestamp>.bundle`.

### Block Sync on Snapshot Failure

Available for **Always Backup** and **Smart** strategies. When enabled, if the snapshot creation fails (disk full, permissions error, etc.), the sync is also blocked. When disabled, sync continues even if the snapshot couldn't be created.

Recommended: **enabled** if you rely on backups for recovery.

## Backward Compatibility

The old `backupBeforeSync` boolean is still recognized:

| Old Setting | New Equivalent |
|---|---|
| `backupBeforeSync: true` | `backupStrategy: "always"` |
| `backupBeforeSync: false` | `backupStrategy: "disabled"` |
| Neither set | `backupStrategy: "on-force-push"` (new default) |

Existing configurations are automatically mapped. The old field is deprecated but will continue to work.

## Environment Variables

No new environment variables are required. The backup strategy is configured through the web UI and stored in the database alongside other config.

## API

### Approve/Dismiss Blocked Repos

When using the `block-on-force-push` strategy, repos that are blocked can be managed via the API:

```bash
# Approve sync (creates backup first, then syncs)
curl -X POST http://localhost:4321/api/job/approve-sync \
  -H "Content-Type: application/json" \
  -H "Cookie: <session>" \
  -d '{"repositoryIds": ["<id>"], "action": "approve"}'

# Dismiss (clear the block, resume normal syncing)
curl -X POST http://localhost:4321/api/job/approve-sync \
  -H "Content-Type: application/json" \
  -H "Cookie: <session>" \
  -d '{"repositoryIds": ["<id>"], "action": "dismiss"}'
```

Blocked repos also show an **Approve** / **Dismiss** button in the repository table UI.

## Architecture

### Key Files

| File | Purpose |
|---|---|
| `src/lib/utils/force-push-detection.ts` | Core detection: fetch branches, compare SHAs, check ancestry |
| `src/lib/repo-backup.ts` | Strategy resolver, backup decision logic, bundle creation |
| `src/lib/gitea-enhanced.ts` | Sync flow integration (calls detection + backup before mirror-sync) |
| `src/pages/api/job/approve-sync.ts` | Approve/dismiss API endpoint |
| `src/components/config/GitHubConfigForm.tsx` | Strategy selector UI |
| `src/components/repositories/RepositoryTable.tsx` | Pending-approval badge + action buttons |

### Detection Flow

```
syncGiteaRepoEnhanced()
  │
  ├─ Resolve backup strategy (config → backupStrategy → backupBeforeSync → default)
  │
  ├─ If strategy needs detection ("on-force-push" or "block-on-force-push"):
  │    │
  │    ├─ fetchGiteaBranches() — GET /api/v1/repos/{owner}/{repo}/branches
  │    ├─ fetchGitHubBranches() — octokit.paginate(repos.listBranches)
  │    │
  │    └─ For each Gitea branch where SHA differs:
  │         └─ checkAncestry() — octokit.repos.compareCommits()
  │              ├─ "ahead" or "identical" → fast-forward (safe)
  │              ├─ "diverged" or "behind" → force-push detected
  │              └─ 404/422 → old SHA gone → force-push detected
  │
  ├─ If "block-on-force-push" + detected:
  │    └─ Set repo status to "pending-approval", return early
  │
  ├─ If backup needed (always, or on-force-push + detected):
  │    └─ Create git bundle snapshot
  │
  └─ Proceed to mirror-sync
```

## Troubleshooting

**Repos stuck in "pending-approval"**: Use the Approve or Dismiss buttons in the repository table, or call the approve-sync API endpoint.

**Detection always skipped**: Check the activity log for skip reasons. Common causes: Gitea repo not yet mirrored (first sync), GitHub API rate limits, network errors. All are fail-open by design.

**Backups consuming too much space**: Lower the retention count, or switch from "Always Backup" to "Smart" which only creates backups on actual force-pushes.

**False positives**: The detection compares branch-by-branch. A rebase (which is a force-push) will correctly trigger detection. If you routinely rebase branches, consider using "Smart" instead of "Block & Approve" to avoid constant approval prompts.
