# Source Providers

GitHub to Gitea is the supported default. Every other source and every other destination is marked **beta** in the dropdowns: they are tested end to end against real hosts, but have had less time in the field. The destination card has a matching **Destination** dropdown with Gitea, Forgejo (beta, same API as Gitea), GitHub (beta) and GitLab (beta); `DESTINATION_PROVIDER` sets it from the environment, and [PUSH_TARGETS.md](PUSH_TARGETS.md) covers the GitHub and GitLab targets.

Gitea Mirror pulls repositories from one source host per user. GitHub is the default. GitLab and Gitea/Forgejo are available from the **Source** dropdown at the top of the connection card on the Configuration page.

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
| Add a single repository by URL | yes | yes | yes |
| Issues, pull requests, labels, milestones | yes | no | no |
| Releases with assets | yes | no | no |
| Star lists | yes | no | no |
| Force push detection | yes | no | no |

The GitHub only rows read the GitHub API. For other sources the corresponding switches are disabled on the Configuration page, and the mirror step skips them.

## Behaviour to know about

- **The source locks once repositories are imported, and the destination locks once anything is mirrored.** The Source dropdown, the instance URL and the Gitea server URL then show a lock note and a **Change** button. Changing one is still possible, but only after confirming a dialog that spells out what happens to the existing repositories. Saves that try to switch a locked host without that confirmation are refused by the API, and an environment variable that disagrees with a locked host is ignored on boot with a warning.
- **One source at a time.** Switching the source does not touch repositories that were imported from the previous host. They keep syncing, because Gitea already holds their clone credentials. The cleanup service ignores them, and mirroring one of them again is refused with an error naming both hosts. Remove the repository and add it again from the current source if you need to re-mirror it.
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

See [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) for the full list.

## Not yet

Several sources at once (the tracking issue is #375, the follow up is a list of sources in the card), targets other than Gitea/Forgejo (see the `feature/matrix` branch), and hosts without a usable API.
