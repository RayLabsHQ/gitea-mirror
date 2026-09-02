# Push targets: GitHub and GitLab as destinations

Gitea and Forgejo are pull mirrors: the app asks them to fetch from the source, and they keep the copy up to date themselves. GitHub has no pull mirror API and GitLab only offers one on paid tiers, so for those two the app runs a push engine instead. This page explains what that engine does, what it needs, and what it does not do.

Push targets are marked **beta** in the destination dropdown.

## How it works

For every repository whose destination is GitHub or GitLab:

1. **A bare clone is kept on disk** under `<data dir>/mirrors/<source host>/<owner>/<name>.git`, next to the SQLite database. The first run clones, later runs fetch with prune, so a branch or tag deleted on the source is dropped from the clone.
2. **The target repository is created when missing.** GitHub: under the account named in the connection card, or under an organization the mirror strategy picks. GitLab: a project under the user, or in a group; a missing top level group is created, a nested group is not.
3. **Branches and tags are pushed** with force and prune. The target always ends up matching the source, including rewritten history and deleted branches. Pull request refs, merge request refs and other host owned namespaces are not pushed; hosts refuse writes to them.
4. **The default branch is set** on the target to match the source, best effort.
5. **Statuses, mirror jobs and activity rows** are the same as for a Gitea mirror, so the dashboard, the scheduler, recovery and cleanup treat both the same way. The repository table shows the destination's icon and links to the target repository.

The scheduler runs the same fetch and push on every scheduled sync. Both steps are idempotent: an interrupted run just runs again.

## The target is overwritten

Every push uses force and prune. Anything committed directly on the target, a branch created there, a tag moved there, is replaced by what the source has on the next sync. Treat a push target as read only, the same way a Gitea pull mirror is.

## What is not mirrored

Push targets receive **branches and tags only**. The following are not available for them and show as disabled in the settings:

- issues, pull requests, labels, milestones
- releases and release assets (tags do travel)
- wiki
- LFS objects
- force push protection and the backup strategies

Several destinations per repository, and pulling anything back from the target, are out of scope. Mirroring is one way.

## Credentials

Tokens never appear in a URL and are never written to disk. Each git invocation gets an inline credential helper that reads the token from an environment variable set on that process only: the source token for the fetch, the target token for the push. The remote URL stored in the bare clone is the plain source URL.

Token scopes:

| Target | Scopes | Notes |
|--------|--------|-------|
| GitHub | `repo`, `workflow` | `workflow` is needed as soon as a repository contains GitHub Actions files, or the push is rejected. Add `delete_repo` only if cleanup should delete repositories on GitHub. |
| GitLab | `api`, `write_repository` | Pushes use the `oauth2` user name with the token, as GitLab documents. |

GitHub organizations cannot be created through the API. Create the organization first and make the token's user a member with permission to create repositories.

## Disk usage and concurrency

A bare clone takes roughly the size of the repository's git objects, so the data directory grows by about the size of everything you mirror this way. Clones are removed when the repository row is deleted, and by cleanup when it deletes an orphaned repository.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MIRROR_CLONE_DIR` | `<data dir>/mirrors` | Where the bare clones live. |
| `PUSH_CONCURRENCY` | `2` | How many git fetch or push operations run at the same time across all repositories. API calls are cheap, a clone or a mirror push is not. |

One git process per repository at a time is enforced with a lock file next to the clone. A lock older than an hour belongs to a run that died and is taken over; a half written clone (no `HEAD`) is removed and cloned again.

## Large first pushes

GitHub limits the size of a single push. When the single push of all refs is refused, the engine retries in batches of 50 refs, branches first, then tags, followed by a prune. If a batch is still refused, the mirror fails with the git error in the repository's status.

## Cleanup

When the source deletes a repository, the cleanup service applies the configured action to the target through its API: archive on GitHub (`archived: true`) or GitLab (`/archive`), or delete. Deleting on GitHub needs the `delete_repo` scope; without it the cleanup run fails with a message naming the scope and the repository stays. On gitlab.com and instances with delayed deletion, a deleted project is renamed and kept for the configured number of days before it disappears. The bare clone is removed with the row.

The **Reconcile with destination** action compares a Gitea or Forgejo server with the database; it is not available for push targets, which have no server side mirror state to reconcile.

## Switching destinations

Once anything has been mirrored the destination is locked and changing it asks for confirmation, as for Gitea. Rows remember which destination they were mirrored to; a row mirrored to one host is refused on another until it is removed and mirrored again, so a token is never sent to the wrong host.

## Environment variables

```env
DESTINATION_PROVIDER=github      # or gitlab
GITEA_URL=https://github.com     # optional for github.com and gitlab.com; set for GHES or self hosted GitLab
GITEA_USERNAME=your-account
GITEA_TOKEN=your-token
GITEA_ORGANIZATION=your-org      # optional, used by the single-org strategy
MIRROR_CLONE_DIR=/data/mirrors   # optional
PUSH_CONCURRENCY=2               # optional
```

The `GITEA_*` names are kept for every destination kind so an existing deployment only has to change `DESTINATION_PROVIDER`. See [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md).
