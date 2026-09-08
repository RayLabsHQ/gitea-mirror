# Source Providers

GitHub to Gitea is the supported default. Every other source and every other destination is marked **beta** in the dropdowns: they are tested end to end against real hosts, but have had less time in the field. The destination card has a matching **Destination** dropdown with Gitea, Forgejo (beta, same API as Gitea), GitHub (beta) and GitLab (beta); `DESTINATION_PROVIDER` sets it from the environment, and [PUSH_TARGETS.md](PUSH_TARGETS.md) covers the GitHub and GitLab targets.

Gitea Mirror pulls repositories from as many source hosts as the user connects, github.com and a GitHub Enterprise instance included. The connection card on the Configuration page is a list of sources with add, edit and remove. GitHub is the default, and GitLab and Gitea/Forgejo are available from the **Source** dropdown when a source is added or edited.

| Source | Covers | Default instance URL |
|--------|--------|----------------------|
| GitHub | github.com, GitHub Enterprise (via `GH_API_URL`) | `https://github.com` |
| GitLab (beta) | gitlab.com, self hosted GitLab | `https://gitlab.com` |
| Gitea / Forgejo (beta) | Codeberg, self hosted Gitea or Forgejo | `https://codeberg.org` |

Picking GitLab or Gitea/Forgejo shows an **Instance URL** field. Leave it empty for the default instance, or enter the base URL of your own (for example `https://gitlab.example.com` or `http://gitea.local:3000/gitea`). The username and token fields hold the account and token for the selected host.

## Tokens

| Source | Where to create the token | Scopes |
|--------|---------------------------|--------|
| GitHub | Settings, Developer settings, Personal access tokens (classic) | `repo`, `admin:org` |
| GitLab | Preferences, Access tokens | `read_api`, `read_repository` |
| Gitea / Forgejo | Settings, Applications | `read:repository`, `read:user`, `read:organization` |

The **Test** button on the card checks the token against the selected host.

## What is mirrored

The mirror itself is done by Gitea's pull mirror, which treats every source as a plain git remote. The differences are in what the source API offers.

| | GitHub | GitLab | Gitea / Forgejo |
|---|:---:|:---:|:---:|
| Code, branches, tags | yes | yes | yes |
| Wiki | yes | yes | yes |
| LFS objects | yes | yes | yes |
| Scheduled sync | yes | yes | yes |
| Auto import of new repositories | yes | yes | yes |
| Cleanup of repositories deleted upstream | yes | yes | yes |
| Starred repositories | yes | yes | yes |
| Private repositories | yes | yes | yes |
| Entire organizations (GitLab: top level groups) | yes | yes | yes |
| Add a single repository by URL | yes | yes | yes |
| Issues, pull requests, labels, milestones | yes | no | no |
| Releases with assets | yes | no | no |
| Star lists | yes | no | no |
| Force push detection | yes | no | no |

The GitHub only rows read the GitHub API. For other sources the corresponding switches are disabled on the Configuration page, and the mirror step skips them.

Entire organizations also mirror without a token on every source; the next section covers public mode.

## Public organizations (no source connection)

An organization or group can be mirrored without any source account. Gitea Mirror lists the public repositories of a GitHub organization, a GitLab group or a Gitea/Forgejo organization on github.com, gitlab.com, a self hosted GitLab instance or a Gitea/Forgejo instance, and mirrors code, branches, tags, wiki and LFS objects through an anonymous mirror clone.

On the Organizations page, **Add organization** has a public mode, which is the default when no source is connected: pick the provider, fill in the instance URL for a self hosted GitLab or Gitea/Forgejo host (empty means the default instance), and enter the organization name. Saving creates a public only source row for that instance automatically, so the sources card does not have to be visited first. The row appears in the sources card with a public only indicator and can be edited or removed like any other source. New repositories added to the organization upstream are discovered on the next scheduled run.

Public mode degrades in known ways:

- **GitHub metadata is best effort.** Anonymous requests run under GitHub's 60 requests per hour limit, so a large organization can end up with partial metadata. Releases, description and topics mirror anonymously with no account at all. Issues, pull requests, labels and milestones are also fetched anonymously once any source in the account carries a token; with no token anywhere they are skipped, and the mirror itself is unaffected either way.
- **GitLab and Gitea/Forgejo sources mirror code only.** Metadata remains GitHub only, as in the table above, and issues and merge requests from those sources stay a Not yet item with or without a token.
- **Personal auto discovery and starred repositories need a token.** Neither runs for a public only source.
- **Cleanup does not run.** Repositories deleted upstream are not detected for public only sources.

Listing and metadata go through the source API and are rate limited by the host when anonymous:

| Source | Anonymous API limit |
|--------|---------------------|
| GitHub | 60 requests per hour per IP address |
| GitLab.com | 500 requests per minute per IP address. GitLab has announced a phased reduction to 60 requests per hour for unauthenticated API traffic, planned for late 2026 |
| Gitea / Forgejo | No built in API rate limit. Instances may throttle or close anonymous API access on their own |

The mirror itself is a plain git clone and does not consume API requests.

Adding a username and token to the public only row on the Configuration page upgrades it to a regular source: private repositories, personal auto discovery and starred repositories start working, and GitHub metadata moves from the anonymous limit to the authenticated one. The public only row also enables adding a public repository by URL on that host, which needs a source row but no token.

The API accepts the same fields. `POST /api/sync/organization` adds a public organization like this:

```json
{ "org": "acme", "role": "member", "provider": "gitlab", "sourceUrl": "https://gitlab.example.com" }
```

`provider` is `github`, `gitlab` or `gitea`. `sourceUrl` is optional and defaults to the provider's default instance from the table at the top.

## Behaviour to know about

- **Each source locks once repositories are imported from it, and the destination locks once anything is mirrored.** A locked source's **Source** dropdown and instance URL, and the Gitea server URL, then show a lock note and a **Change** button. Changing them is still possible, but only after confirming a dialog that spells out what happens to the existing repositories. Removing a source that has repositories needs an explicit confirmation too. Saves that try to switch a locked source without that confirmation are refused by the API, and an environment variable that disagrees with a locked source is ignored on boot with a warning.
- **Sources run side by side.** Every connected source discovers, imports and mirrors independently, and each repository remembers which source it came from. Cleanup checks each source's own repositories, and mirroring a repository uses its own source's credentials. Repositories whose source was removed keep syncing on the Gitea side, because Gitea holds the stored clone credentials, but re-mirroring, metadata and cleanup skip them.
- **GitLab groups are flattened.** A project under `group/subgroup/project` lands in the Gitea organization `group` (with the preserve strategy) and keeps its full path as the repository's full name. The "Limit to specific groups" filter matches the top level group.
- **GitLab internal projects are treated as private** when the mirror is created, because they are not visible to anonymous users on the source either.
- **Repository names come from the URL path**, not the display name, so a GitLab project called "My Widget" with path `my-widget` mirrors as `my-widget`.
- **Without a token** only the configured user's public repositories and starred repositories are visible on GitLab and Gitea/Forgejo. Adding a public repository by URL works without a token on every source.

## Environment variables

| Variable | Description |
|----------|-------------|
| `SOURCE_PROVIDER` | `github` (default), `gitlab` or `gitea` |
| `SOURCE_URL` | Instance base URL for GitLab and Gitea/Forgejo |
| `GITHUB_USERNAME` | Username on the selected host |
| `GITHUB_TOKEN` | Token for the selected host |

These variables initialize or update the first source connection, creating it when none exists, and never switch a source that is locked. A `GH_API_URL` set for a single GitHub Enterprise deployment keeps applying to sources that point at github.com, so adding a github.com source in such a deployment sends its token to the configured Enterprise API; connect the Enterprise host as its own source instead.

See [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) for the full list.

## Not yet

Hosts without a usable API, and issues, merge requests and releases from GitLab, Gitea or Forgejo sources. Discovery preferences are shared, so filters apply to all sources rather than per source, and the GitHub and GitLab rate limit buckets are shared per provider. GitHub and GitLab as destinations shipped in 3.31.0 through the push engine, see [PUSH_TARGETS.md](PUSH_TARGETS.md).
