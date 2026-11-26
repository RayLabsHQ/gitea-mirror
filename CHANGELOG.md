# Changelog

All notable changes to the Gitea Mirror project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Move mirrors to match your settings** (#550, thanks @zwimer). A changed strategy, organization destination or starred setting only applied to new mirrors, so mirrors made earlier stayed in their old place for good. The Organization Structure card now says when some mirrors are not where the settings put them, and **Review and move** shows, before anything changes, what will move where, what is blocked and why (name taken, a person's account, a reserved name, missing rights, or the mirror not found), and what is left out. **Use the source name** gives moved mirrors their source repository's name when it is free; a move never makes up a name. The move checks each mirror again right before moving it, records where it is after every step, and can be closed and followed from the card. Gitea and Forgejo destinations only. Also through `/api/placement/summary`, `/api/placement/preview` and `/api/placement/run`
- **Several statuses at once** in the Repositories page's status filter (#580, thanks @zwimer). The filter is now a list of checkboxes with **Select all** and **Clear**, so it can show Mirrored, Syncing and Synced together, or everything except Imported. Each status shows its count. The address keeps the choice as `?status=mirrored,synced`; links with a single status, and the parameter repeated, still work
- **Two-factor authentication** with an authenticator app (#552, thanks @zwimer). In the account menu, **2FA** > **Set up** sets it up with a QR code and gives ten backup codes to save; once it is on, the item shows a switch that turns it off. Logging in with a password then asks for the app's code, or a backup code, with **Trust this device for 30 days** off by default. Wrong codes are limited per login and lock code entry for 15 minutes after ten in a row. It covers the email and password login; SSO, header auth and API keys are unchanged. `bun run disable-2fa -- --email=...` turns it off for someone who lost both the phone and the codes. Built on Better Auth's two-factor plugin
- **Wait before acting** for repository cleanup (#549, thanks @zwimer). A deleted repository sometimes comes back, so the Repository Cleanup card can now wait a number of days before archiving or removing a repository whose source is gone. The first check that finds the source gone records the time; if the source comes back during the wait, nothing happens and the count starts over, and a failed lookup neither starts nor resets it. Run now lists the waiting repositories with the day they will be acted on, and with cleanup notifications on, a heads-up names them and that day when the wait starts. Also `CLEANUP_ORPHANED_REPO_GRACE_DAYS`. `0`, the default, acts right away as before
- **Repository cleanup** notifications (#554, thanks @zwimer). A new switch under Notification Events sends one notification per cleanup run listing the repositories it archived or removed because their source is gone, and any it could not handle, so a mirror no longer changes without a word. It says whether the destination was changed or only gitea-mirror's own list. Dry runs and the `skip` action send nothing, and an archived repository is reported once. Off by default. Webhooks get the new type `repo_cleanup`
- **Security advisories** can be mirrored (#561, thanks @zwimer). Gitea and Forgejo have no advisories of their own, so with the new **Security advisories** option under **Metadata to mirror** each published GitHub security advisory becomes an issue on the mirror, labeled `security-advisory` and titled with its GHSA id, carrying the severity, CVE, weaknesses, affected and patched versions, credits and the advisory's text. It is updated in place when the advisory changes and closed if the advisory is withdrawn. Draft and triage advisories are never mirrored, even when the token can see them. It needs a GitHub source, costs one request per repository and sync (free when nothing changed), can be overridden per organization and repository, and can be set with `MIRROR_SECURITY_ADVISORIES`. Off by default
- **Pre-release limit** caps how many of the mirrored releases may be pre-releases (#560, #538, thanks @zwimer and @MajMcCloud). A project that publishes a build every night filled the release limit with nightly builds, so its stable releases never reached the destination, and turning pre-releases off dropped the nightly builds entirely. With pre-releases on, **At most** under the switch keeps the newest N pre-releases and gives the other places to the newest stable releases, looking up to 1,000 releases back and stopping as soon as the places are filled. `0` keeps no pre-releases, and empty keeps the old behaviour. Pre-releases past the limit are removed from the destination on the next sync, the newest kept. It can be overridden per organization and repository, and set with `RELEASE_PRERELEASE_LIMIT`
- **Same as other repos** for starred repositories (#551, thanks @zwimer). The starred destination offered a dedicated organization or **Preserve source owner**, and the second put each starred repository under its GitHub owner's name even with the single organization strategy, while its description suggested it followed the strategy. The new option places starred repositories like any other: the mirror strategy, an organization's destination and a repository's own destination, which can now be edited for them. A starred repository whose name is already taken in that place gets the owner's name added, as in the dedicated organization. The two existing options now say what they do. `STARRED_REPOS_MODE=follow-strategy` sets it, and an unknown value in that variable is now ignored instead of stored
- **Run now** buttons on the Database Maintenance and Repository Cleanup cards of the Automation tab (#547, thanks @zwimer). Database maintenance trims the activity log right away and says how many entries it removed. Repository cleanup checks the sources right away instead of at the next check, shows its progress and outcome in the card's footer with the repositories and any errors one click away, and asks first when its action would change anything. Database maintenance can also be run with `POST /api/cleanup/maintenance`
- **Auto-import new repositories** switch on the Automation tab (#541). Auto import could only be turned off with `AUTO_IMPORT_REPOS=false`, although the docs described a switch for it. It sits next to Auto-mirror new repositories, and when it is off, scheduled syncs and the run after startup only update the repositories you already have
- `ENVIRONMENT_SEEDING` decides whether environment variables are copied into the settings (#541). They were only copied when `GITHUB_USERNAME`, `GITHUB_TOKEN`, `GITEA_URL`, `GITEA_USERNAME` or `GITEA_TOKEN` was set, so keeping tokens on the Configuration page meant giving up variables such as `AUTO_IMPORT_REPOS`. `true` copies them without any of those five, `false` never copies them, and leaving it unset keeps the old rule
- `GITLAB_PAGE_SIZE` sets how many projects a GitLab listing asks for at a time, from 10 to 100 (#506). Listings start at 100 and drop to 50, 20, then 10 when a page times out, so a slow GitLab paid about 30 s per step on every import and scheduled run. Setting it lower starts there instead; the step down still runs below it. Anything outside 10 to 100 is ignored with a warning
- **Git URL source** (beta) mirrors any repository that can be cloned over http(s), for hosts with no API this app knows, such as cgit, gitweb, Gitflic or kernel.org (#514, #508). Connect the host as a source on the Configuration page, with a username and password only if it asks for a login, then add repositories one at a time by pasting their clone URL on the Repositories page. Branches and tags are mirrored. There is nothing to list on such a host, so there is no import, no organizations or stars, no releases or issues, and cleanup never treats these repositories as deleted upstream. Force push detection needs the GitHub API, so use the Always Backup snapshot strategy for these. SSH remotes are not supported
- **Stalled sync warning** (#493). Gitea and Forgejo answer a mirror sync request by queueing it, and say OK before it runs, so a stuck mirror queue looked like a working sync: gitea-mirror kept reporting syncs while Gitea fetched nothing, and new releases waited on tags that never arrived. Each sync now compares Gitea's last mirror run with the one it saw before the previous request. When a request has gone unrun for over an hour, the Activity Log gets a warning for that repository that points at Gitea's mirror queue, and a notification goes out through the **Sync errors** switch, at most once every six hours per user. It reads the repository lookup the sync already makes, so it costs no extra requests
- **Issue filters** narrow issue mirroring (#491). A state filter creates only open or only closed issues; an issue that is already mirrored keeps following GitHub, so closing it there still closes the copy. Comments can be skipped, which also skips the comment listing for each issue, and images, videos and attached files can be left out of issue bodies and new comments, replaced by `[media omitted]`. All three sit under the metadata options and can be overridden per organization and repository. With media off, mirrored issue bodies lose their media as they are next synced; comments already mirrored stay as they are. Changing the state filter runs a full issue pass on the next sync
- **Refresh sizes** on the Storage page measures every mirror now instead of waiting for its next sync, so the page fills in on a fresh install. It only reads the destination: one repository listing per destination owner, the single repository GET for a mirror the listing does not have, and the release listing of repositories that mirror releases. It runs in the background with its progress on the button (`POST /api/storage/refresh`)
- **Remove old release assets** brings the attachments of older releases under a release asset limit. Turning the limit on, or lowering it, used to leave every file uploaded earlier in place, so the limit only held for the future. With the switch on, a kept release past the newest N releases that get assets loses its attachments on the next sync; the release, its notes and its tag stay, and a release whose attachments cannot be listed is left alone. It is a global setting (`PRUNE_OLD_RELEASE_ASSETS`, off by default) because it deletes files from the destination, while the limit it works with stays configurable per organization and repository
- **Destination filter** on the Repositories page lists repositories by where they mirror to, worked out the way the mirror does it: the starred organization, the repository's own destination, its organization's destination, then the mirror strategy (#492). The Organization column names that same destination now. It used to work it out in the browser and got some cases wrong, such as personal repositories under the mixed strategy, which it showed under the Gitea user instead of the organization they mirror into

### Security
- Only the instance owner can create OAuth applications. Any signed-in account could create one through the auth library's own endpoints and give it a familiar name and its own redirect address; anyone who approved it on the real consent page handed that account a token for their own account. Creating, registering, listing, changing and deleting applications now answer 403 for other accounts, the same rule as SSO providers. Deleting an application also ends the tokens it was given, where it used to leave them working until they expired, and the owner can now remove an application another account made. Applications made by other accounts in earlier versions are listed for the owner to check
- Only the instance owner, the first account created, can manage SSO providers (GHSA-c6c2-hr73-h7hw, thanks @naroSEC and @lml20000827). Any signed-in account could add a provider for another user's email domain, sign in through its own identity provider with that user's email, and be linked into their account, the admin's included. Providers apply to the whole instance, so adding, changing and removing them is now refused for everyone else, also through the SSO plugin's own endpoints, and the owner sees every provider. Providers that another account added earlier stop working for sign-in until the owner edits and saves them; the panel marks them. Accounts with a sign-in linked through one of those, or through a provider that has since been deleted, are signed out once on upgrade, their OAuth tokens are deleted and their API keys turned off, which ends any access gained this way; the keys stay listed so you can check them. The OAuth applications API (`/api/sso/applications`) is owner-only too, except looking up the one application a consent screen asks about.
- Saved tokens and secrets can no longer be read back. `GET /api/config` and `GET /api/sources` returned the source and destination tokens, the ntfy, Apprise and Gotify tokens and the webhook signing secret decrypted, so anything that could read settings, a read only API key included, could copy them. They now come back empty, with `hasToken` (`hasSecret` for the webhook signing secret) saying whether one is saved, and sources leave `token` out. An empty field still keeps the saved value and a new one replaces it; the optional ntfy token and webhook signing secret get a **Remove** button, which sends `null`. Test buttons use the saved token when the field is empty. Scripts that read tokens from these endpoints need to keep their own copy
- A saved token is only sent to the address it was saved for: the same scheme, host and port. Pointing the destination, a source or a notification service at another host, another port or plain http without entering a new token is refused with a message saying so, where it used to send the saved token to the new address. The webhook signing secret is never sent anywhere, so it stays when the webhook URL changes
- Signing in through SSO no longer creates an account for anyone the identity provider knows. Email sign-up closes once the first account exists, but SSO kept creating accounts, so with Google as a provider any Google account could get in. Once an account exists, SSO now only creates one when the email belongs to the provider's Email Domain; `AUTH_ALLOW_SIGNUP=true` lets anyone in, as it does for email sign-up
- An SSO sign-in is no longer linked to a local account from another domain. When the identity provider said the email was verified, the sign-in was linked to the local account with that email whatever the provider's Email Domain, so someone who could get that email at the provider could take over the account. Linking now only happens for emails in the provider's domain, as the docs already said

### Changed
- A change on the Configuration page that leaves mirrors out of place now brings up a bar at the bottom of the page saying how many, with **Review and move** and **Not now** (#550). The count was only in the Organization Structure card's footer, which on a laptop sits below the fold while you pick a strategy, so nothing said the change touched existing mirrors. The bar shows wherever the page is scrolled, follows a move started from it until it ends, and **Not now** puts it away until the next change. Mirrors that were already out of place when the page opened are still shown in the card only
- GitHub App sources reuse GitHub's "not modified" answers (#563, thanks @cypherbits). Sources with a token already kept the ETag of each listing and asked again with it, which GitHub answers for free when nothing changed, but App sources fetched everything in full on every sync, so each scheduled sync spent the installation's rate limit on repository details, releases, milestones, issues and pull requests that had not changed. Sources without a token are unchanged, since GitHub counts those answers anyway
- Issue and pull request syncs make fewer GitHub requests that count against the rate limit (#555, thanks @cypherbits). The incremental listing carries the time of the last pass, so every sync asked for a new URL and never got GitHub's "not modified" answer, which is free. That time is now rounded down to the hour, so the pull request pass gets the free answer for the listing the issue pass just made, and syncs less than an hour apart share it too. A sync may look again at up to an hour of issues and pull requests that are already mirrored; they are updated in place, not copied again
- Issues that GitHub lists with no comments no longer get a separate request for their comments (#556, thanks @cypherbits). The listing already says how many there are, so this saves one request per such issue, most of all on a full pass
- The compose files and the Docker examples in the docs drop all Linux capabilities and set `no-new-privileges` (#544, thanks @zwimer). The app runs as a regular user and never had any of the capabilities Docker grants by default, so nothing changes day to day; it limits what someone who broke into the container could do. If you run the container as root, remove `cap_drop` or make sure the data directory belongs to root
- The Dashboard's Repositories and Recent Activity lists run down to the bottom of the screen instead of stopping at eight rows, so a tall screen shows more and a short one fewer, up to 50. They follow the window as it is resized. On narrow screens, where the two lists stack, they still show eight
- Pages keep what they last showed in this browser tab. Going back to the Dashboard, Repositories, Organizations, Storage or Activity Log shows that data at once and refreshes it in the background, instead of starting from a skeleton and waiting for the whole list again. Nothing is written to browser storage; a reload or a new tab starts fresh

### Fixed
- **A mirror run deleted a regular repository that had the name it needed**, then created the mirror in its place. It now leaves that repository alone and fails with a message saying to rename or delete it on the destination, or to give the repository another destination. A failed import looks the same and is deleted by hand from its page on the destination, as before
- **Repository cleanup could archive or delete a repository that was not the orphan's mirror**, with **Apply to the destination too** on. A row with no recorded location was acted on wherever the mirror strategy would put it, whatever sat there: a regular repository, another source's mirror of the same name, or, through the redirect Gitea leaves at the old address of a renamed repository, wherever that repository went. Cleanup now only acts on a repository it has confirmed mirrors that source, at its current address, and deletes never follow a redirect. Run now, the cleanup event and the notification name what was left alone
- **Creating an OAuth application with a refused redirect URL failed with a 500** that hid the reason. `POST /api/sso/applications` now answers 400 with what is wrong and what to use instead (web applications need https on a real host name; `type: "native"` allows http on localhost). Changing redirect URLs with `PUT` follows the same rules per application type, which it did not before; a URL the application already has can stay
- Repository cleanup during a scheduled sync ignored **Protected repositories** and sent no cleanup notification, because it ran its own loop over the orphaned repositories. It now runs the same cleanup as the 6 hour check and Run now (#549)
- `PUT /api/sso/applications` can change an OAuth application. Every change was refused, because the request did not match what the auth library expects, and `disabled` could not be set at all. Dynamic client registration at `/api/auth/oauth2/register` works for the owner too: an old route of the app's answered that address and failed every request
- The Repository Cleanup card now has the **Apply to the destination too** switch (#558, thanks @zwimer). It was only available as `CLEANUP_DELETE_FROM_GITEA`, so with the card set to archive or delete, cleanup only changed gitea-mirror's own list and left the destination alone without saying so. The action tiles now say which of the two happens, and the Database Maintenance card says it never touches repositories.
- A job that keeps taking the app down is no longer resumed on every restart (#564, thanks @nyrixx). After a crash, a job was only resumed once its last checkpoint was 10 minutes old, although nothing else could still be running it, so the app went down again about 10 minutes after each start, with no end. Jobs left by the previous run are now resumed as soon as the server starts, and a job resumed 3 times in a row without finishing a repository is marked failed with a message saying so. The startup step in Docker and Nix no longer resumes jobs itself: it stopped after 30 seconds with the job half done. A clean stop also left its jobs unfinished for good, despite saying they would resume on restart; they now resume too
- Hitting GitHub's rate limit during a mirror, sync or retry started from the UI no longer shuts the app down (#557, thanks @zwimer and @nyrixx). The batch stopped as it should, but the error it ended with had nothing to catch it, so the server treated it as a crash and exited. Scheduled syncs were not affected. Repositories the batch did not reach keep their status.
- Database maintenance's next run follows the retention period (#548, thanks @zwimer). Changing the retention period kept the next run where the old period had put it, so going from 3 months to 1 day still waited up to a week while the card said it runs every 6 hours. Shortening the period now brings the next run forward, and lengthening it never pushes back a run that is due. Repository cleanup also wrote its own time into the same field, moving the next maintenance run to a day later whenever it found a repository whose source was gone; it no longer touches it. The Repository Cleanup card now says it checks every 6 hours and with each scheduled sync, where it only mentioned the sync
- Release asset uploads no longer fill the disk (#539). When the destination answered before reading the whole upload, such as a reverse proxy refusing a large asset with 413, the temporary file stayed open after it was removed, so its space was only freed by a restart, and every sync retrying the asset leaked another one. The file is now always closed before it is removed
- Mirrors follow a Gitea or Forgejo server that moved to a new address (#535, #536). Every repository recorded on the old address failed with "mirrored to ... but the configured destination is ...", because nothing updated the recorded address. A repository is now repointed when the configured server already has a pull mirror of the same source, at the repository's recorded or expected location, that the token can push to. Push targets are never repointed
- `/api/health` caches a failed check for the latest release for 15 minutes and keeps the last version it knew (#533, #534). Only a successful check was cached, so after one failure every health check (every 30 seconds in Docker) asked GitHub again and kept the anonymous rate limit used up
- `AUTO_IMPORT_REPOS=false` (auto import off) now also holds for the run right after startup (#532). With scheduling on, that first run imported every repository from the sources on each restart; only the scheduled runs after it checked the switch
- **Discover** on the SSO provider form no longer puts the provider's hostname (such as `accounts.google.com`) into the Domain field. Domain is your users' email domain, and since SSO only creates accounts and links existing ones for emails in that domain, the hostname refused everyone. The form and the provider list now warn when Domain is the provider's hostname, so providers saved that way can be fixed
- Settings saved on the Configuration page no longer turn back off at every restart when a GitHub or Gitea credential is set through environment variables. In that setup the environment is read again on each start, and a true/false variable that was not set counted as false and was saved over the stored value. That switched off topics, issue and other metadata mirroring, private repositories, the schedule, skipping recently mirrored repositories and more, reset the mirror strategy, and turned import of new repositories back on after it was switched off. A variable that is not set now keeps the stored value; one that is set still wins. `true` is accepted in any case. An interval variable (`GITEA_MIRROR_INTERVAL`, `SCHEDULE_INTERVAL`, `DELAY`) still switches the schedule on, as before
- Organizations pinned to a GitHub App source were labeled **Public only**. An App source has no token, and the label only checked for that
- Mirroring release assets could take all of a machine's memory and push it into swap (#523). Each asset was held in memory while it was copied from the source to the destination, and copied again on the way, so one asset took up to about three times its size, and the memory was not given back between assets: a 300 MB asset took about 1 GB. Assets now pass through a file in the data directory (`data/tmp/release-assets`, next to the database), so a sync holds only a small piece of an asset at a time, whatever its size: in testing, a 1 GB asset peaked at about 160 MB instead of 1.3 GB. The file is removed after each upload, and anything left behind by a crash is cleared after a day. The data directory needs room for the largest asset while it is copied. Uploads to the destination now use chunked transfer encoding instead of a Content-Length header
- A large repository whose first mirror took longer than five minutes failed with `Network error: The operation timed out.`, and Retry then failed with "not a mirror" and `HTTP 400: Bad Request` (#521, #502). gitea-mirror stops waiting for a request after five minutes, but Gitea and Forgejo carry on with the import, and until it ends the repository has no mirror settings, so a sync request is refused. When the migrate call gets no answer, from that timeout or from a proxy, gitea-mirror now looks at the destination and follows the import if one is running. Retry, Sync and scheduled syncs wait for a running import too, up to 30 minutes, instead of failing at once. An import that fails is left on the destination looking exactly like one still running, so the message after the wait, and the "not a mirror" error, now say to delete the repository there and retry
- A mirror the destination refuses to create says why (#511). Gitea and Forgejo reject the request with a plain sentence, such as "You can not import from disallowed hosts." for a source on a private address when `ALLOW_LOCALNETWORKS` is off, but the error only read "HTTP 422: Unprocessable Entity". The sentence is now added to the error, cut to one short line. Other requests still show the status only
- The Dashboard's repository list links to the destination for repositories that are mirroring, syncing or archived, like the Repositories page does, and its status labels are capitalized the same way (#512)
- Importing from a slow self-hosted GitLab failed with `TimeoutError: The operation timed out.` (#506). Projects were listed 100 to a page, and a busy instance took longer than the 30 second source request timeout to build a page of full project objects, even when cached. Listings ask for 100 a page and, when a page times out, carry on from the same place at 50, then 20, then 10 a page, keeping the smaller size for the rest of that listing. v3.51.6 fixed this with 20 a page for everyone, which made the listing about twice as slow on a fast instance (300 projects from gitlab.com: 11 s at 100 a page, 20 s at 20), so only an instance that times out pays for smaller pages now. The listing still stops at 50,000 projects
- A `DATABASE_URL` that is not SQLite, such as a `postgresql://` URL, opened a new, empty database (#502). Until v3.25.0 the variable was not read and the database always lived in `data/gitea-mirror.db`; since then such a URL was read as a file path, so a setup with one started over after upgrading, in a file outside the data volume that a recreated container lost again. The push engine put its clones next to that file too. Any scheme other than `sqlite://` and `file:` is now ignored with a warning, without the URL's password, and the default location is used, which is where those setups kept their data before v3.25.0
- `PRE_SYNC_BACKUP_STRATEGY`, `PRE_SYNC_BACKUP_ENABLED`, `PRE_SYNC_BACKUP_KEEP_COUNT` and `PRE_SYNC_BACKUP_RETENTION_DAYS` had no effect (#503). A new configuration, whether made by the environment loader or on first sign in, stored the built-in backup settings, and a stored setting wins over the environment. They now set the starting values, and so does `PRE_SYNC_BACKUP_DIR`, which a first sign in also overrode. Configurations that already exist keep their settings. The environment loader also no longer turns an old `backupBeforeSync: false` into Smart on restart
- Release asset downloads give up after two minutes without data. A hung connection used to hold the sync for good, since downloads had no timeout at all; such an asset now fails and the next sync tries again
- A repository whose first mirror hit a gateway timeout stayed green without its releases, issues or anything else a first mirror brings (#496). The migrate call stays open for the whole clone, so a reverse proxy can give up on it while Gitea carries on, and the retry then found the repository in place and only recorded that it exists. With scheduling off nothing ever came back for the rest. Finding an existing mirror now runs a full sync, after waiting up to 30 minutes for an import Gitea is still running
- Release assets of private GitHub repositories failed with `404 Not Found` on every sync while their releases, issues and pull requests mirrored fine, because `browser_download_url` only accepts a browser session on a private repository. They now download through GitHub's REST asset URL. Each of those downloads spends one API request and stops when the rate limit gate closes; public repositories keep the browser URL, which spends none (#497)
- Organization cards cut off the buttons on their bottom row when the grid's columns came out narrower than that row, as on a 4K screen with five columns. Columns are now at least 30rem wide instead of 27rem, which fits the row, and a longer label such as Forgejo moves the link buttons onto a second line instead of past the card's edge
- The Activity Log came back as an error instead of the feed once a sync had finished with a warning. A run whose release filter matched nothing on the destination leaves a job whose status is `warning`, and the feed validated the status with the repository status list, which has no such value
- Long lists no longer put every row in the page. The Repositories page built a card for every repository even on desktop, where the cards are hidden, and the Storage table rendered every row; with 3,000 repositories the Repositories page held over 120,000 elements. Only the layout on screen is rendered now, and the mobile cards and Storage rows are virtualized like the desktop table, so a few hundred elements are on the page whatever the count
- The owner and organization filters on the Repositories page and the name filter on the Activity Log list names in alphabetical order regardless of case (#487). A plain sort put every capitalized name before the lowercase ones and accented names last
- Scrolling the Repositories table on desktop dropped frames on slower machines. Each scroll step rendered the filters and every visible row again, and each row coming into view forced a style recalculation for its name. Only the rows coming into view render now; with the CPU slowed 4x, a scroll frame went from about 31 ms to about 13 ms
- Destination release listings stopped after 30 releases. Gitea and Forgejo ignore `per_page` and answer 30 a page, and the listing stopped on any page shorter than the 100 it asked for. The release limit only trimmed within the newest 30 on each sync, the Storage page counted at most 30 releases per repository, and the release filter preview showed only the newest 30 tags. Listings now page with `limit` until the total the destination reports
- The sync button on an archived repository says **Sync** like every other row instead of **Manual Sync**, so the wider label no longer pushes the row's status badge out of line. Hovering it explains that automatic syncs are off for archived mirrors
- The Activity Log summary no longer shows a repository as syncing after a quick sync finished (#454). Events are stored to the second, and a sync that starts and finishes in the same second could come back in the wrong order, so the start event was counted as the current state. Activities now come back newest first within the same second too, and the summary counts a finish over a start from the same second
- Issue and pull request passes over large repositories finish across rate limit resets (#449 follow-up)
  - A pass stopped by the rate limit keeps the numbers it finished, and the next run repeats the same pass and skips them unless they changed since it started; before, every run started over from the first item, so a repository too large for one hour of budget never completed a pass
  - The weekly full pass no longer fetches comments for issues, or the detail, commits and files of pull requests, that are already in the destination and have not changed since the last completed pass; it lists everything and corrects title, body, state and labels from the listing
  - A sync paused by the rate limit logs one line instead of the error object with every partial result, and its activity entry says it was paused
- No request leaves the process while GitHub is rate limited (#437, second report)
  - The v3.37.0 change stopped the scheduler run from holding its lock through a rate limit, but every other request already queued in the run still went to GitHub and came back 403, and the retry helper sent each of them three more times; GitHub counts requests made while limited toward abuse detection and one account was suspended that way
  - Every GitHub client now holds its requests while the source is paused: a limit that resets within two minutes is waited out inside the request, a longer one fails the request at once without contacting GitHub, and the rate limit probe endpoint stays available so the pause can end early
  - The retry helper no longer retries a rate limit refusal and stops starting the remaining items of the batch
  - A rate limit refusal inside the issues, pull requests, releases, labels or milestones pass now fails the repository (which the scheduler already puts back to its previous status and retries after the reset) instead of moving on to the next component, and a pull request whose detail call was refused is no longer written as a stripped down issue
  - A secondary rate limit pauses the whole client for its retry-after window, not only the request that was told to slow down

### Security
- Raised Astro to 7.4.7 and the node adapter to 11.1.13 in the application (GHSA-r3h5-4585-7x3w, the image endpoint could read files from a folder whose name differs from the build output folder only in letter case, on case sensitive filesystems; GHSA-mh32-jxcr-mh9f, attribute injection in dynamic tag names). The documentation site got the same Astro bump in #516. Astro 7.4 needs vite 8.3 and devalue 6, so those overrides moved to `^8.3.5` and `^6.0.3`, both above the earlier security floors
- Source URLs go through the outbound guard too (GHSA-p7w3-46pg-mv6h): `POST /api/sources`, `PUT /api/sources/:id` and the configuration save refuse link local and metadata addresses for source and destination URLs, the source fetch helper pins and never follows redirects like the other user supplied URLs, source errors no longer carry the upstream body in their message, and errors raised by a request to another host are never forwarded to API clients whatever words they contain
- Fixed four privately reported vulnerabilities (GHSA-9m33-xfrc-5jxw, GHSA-6m23-28hh-gjh2, GHSA-2hpx-83vg-gm45, GHSA-5pp8-r7f5-6q8p)
  - `POST /api/gitea/test-connection` and `POST /api/github/test-connection` now require a signed-in user; they were the only non-public API routes without a guard and made a server side request to any URL in the body
  - The email sign-up endpoint is closed server side once an account exists (`AUTH_ALLOW_SIGNUP=true` reopens it); only the signup page redirected before, so anyone reaching the instance could create an account through the API
  - SSO providers are scoped to the user who created them for listing, updating and deleting, and the OIDC client secret is no longer returned by the API (the form keeps the stored secret when the field is left blank)
  - HTTP errors from Gitea and other hosts no longer carry the upstream response body in the message, so an error can no longer echo the content of a host the caller chose
  - Requests to user supplied URLs (connection tests, OIDC discovery, ntfy, Gotify, Apprise and webhook notifications) refuse link local and cloud metadata addresses and no longer follow redirects; private networks stay allowed because mirroring to a LAN Gitea is the normal deployment
- Raised the zod floor to 4.6.7 in the application (GHSA-mrhx-c7xc-m3w5, memory exhaustion while validating an oversized array that has a length limit). Before 4.6.6 zod still checked every element of a list longer than its `.max()`; the MCP tools' repository id list is the one capped array that takes outside input, behind an API key. Astro's own nested zod 4.5.4 now resolves to the same 4.6.7
- Raised the devalue floor to 5.9.2 in the application and the documentation site (GHSA-9rgm-9g3h-6x36, denial of service through malformed input); both lockfiles resolve 5.9.4
- Raised the dependency floors for the advisories published on 2026-09-08: Astro 7.2.8 (remote code execution through AVIF image optimization, and an authorization bypass when stripping the configured base), @xmldom/xmldom 0.8.15 (eight parser and serializer issues), sharp 0.35.4 (libheif), svgo 4.1.0 (removeScripts sanitization) and js-yaml 4.3.2 (merge-key CPU use). Applied to both the application and the documentation site.

### Added
- A Storage page that shows how much space the mirrors take on the destination (#479)
  - Cards for the total, Git + LFS, release assets and how many mirrors are measured, bars by destination owner and for the largest repositories, and a sortable table with search and an owner filter
  - Sizes come from responses a sync already fetches: the destination repository lookup before `mirror-sync` (Git plus LFS) and the release listing the retention pass reads (release assets). No extra requests to the source or the destination
  - A repository whose release assets are most of its size gets a hint that a lower release limit removes the oldest releases
  - The same numbers are available from `GET /api/storage`
- Read only API keys
  - **Create key** in the **API Keys** card has an **Access** choice, and read only keys show a badge in the list
  - A read only key can call every `GET` endpoint; any `POST`, `PUT`, `PATCH` or `DELETE`, and every `/api/auth/*` call except `get-session`, gets `403` with the code `API_KEY_READ_ONLY`
  - Existing keys keep full access
- An MCP endpoint at `/api/mcp` for Claude, Cursor and other MCP clients
  - Takes an API key in `x-api-key`; clients that send headers to a remote server (Claude Code) connect to it directly
  - Eight tools: `list_repositories`, `get_repository`, `list_failures`, `list_organizations`, `add_repository`, `add_organization`, `sync_repositories` and `retry_repositories`. None of them delete, archive or change settings
  - The tools act through the REST API with the caller's key, so a read only key can look but every change is refused. `MCP_INTERNAL_URL` sets the address they use when the app is not reachable on its own `HOST` and `PORT`
  - `gitea-mirror-mcp` in `mcp/` is a stdio bridge for clients that start a local command (Claude Desktop, Cursor). It has no dependencies and is published to npm from `mcp-v*` tags; setup is in `mcp/README.md` and on the documentation site
- Choose which releases count as candidates: every one, or stable releases only
  - A **Pre-releases** switch sits under the two release numbers in the mirror settings, and the same choice is in the per organization and per repository **Mirror options** dialog, where **Inherit** means the global value
  - The release controls in the global mirror settings are listed under each other instead of beside the switch, and in the **Mirror options** dialog the release limit, asset limit and tag rules sit directly under the **Releases** row instead of on a separate tab
  - **Stable only** skips everything the source marks as a pre-release, and the default **All releases** keeps the previous behaviour
  - The filter runs before the release limit and looks further back first, so "the newest 10" means the newest 10 matching releases rather than whatever survives of the newest 10
  - The retention pass also removes destination releases the filter excludes; a release the destination reports no pre-release flag for is kept, so an unknown flag never deletes the wrong thing
  - `RELEASE_TYPE=all|stable` seeds the global default, and no migration is needed because the value lives inside the existing JSON columns
- Filter mirrored releases by tag name with **Include tags** and **Exclude tags**
  - **Custom tag rules...** opens a dialog holding the two lists, both in the mirror settings and in the per organization and per repository **Mirror options** dialog, where leaving both empty means the level above
	- A pattern is a glob over the whole tag (`v*`, `v1.*`, `*-rc.*`, `?` for one character) or a regular expression in slashes (`/^v\d+\.\d+\.\d+$/`), matched case-insensitively; exclude wins when both lists name the same tag, and a pattern that cannot compile is ignored instead of failing the run. Commas inside the slashes belong to the expression (`/^v\d{1,3}\.\d+$/`), in the dialog and in the environment variables alike
  - This is the filter for projects that ship release candidates without marking them as pre-releases, which the type filter cannot separate
  - A tag filter widens the release scan like the type filter does, so the limit counts the releases that match, and the retention pass removes destination releases whose tag no longer matches, including ones the destination reports no pre-release flag for
  - When the filters delete every release the destination had, the activity log shows a highlighted **warning** entry "All releases removed" and the **Sync errors** switch sends the same alert, so an over-broad rule cannot empty the destination silently
	- The dialog lists the releases the destination already holds and crosses out the ones the draft rules would delete on the next sync, so a pattern can be checked before saving. Opened from a repository it previews that one; from an organization or the global settings it adds a picker over the repositories the rules cover
  - `RELEASE_INCLUDE_TAGS` and `RELEASE_EXCLUDE_TAGS` seed the global lists; the values live in the existing JSON columns, so no migration is needed
- Notifications for newly discovered repositories
  - "New repositories discovered" on the Notifications page, with three sub-switches under it: new repositories in your own account, in one of your organizations, and starred repositories
  - The scheduled sync, the boot auto-start and Sync Organization send them once per group with the repositories that were imported; all stars share a single "Starred" alert because their owners are arbitrary, and a long list is cut to the first 10 names plus an "and N more" line
  - The stored configuration gains `notifyOnNewOwnRepo`, `notifyOnNewOrgRepo` and `notifyOnNewStarredRepo` (default on) below the existing `notifyOnNewRepo` master switch; no migration is needed because they live inside the existing JSON column, and a row saved before them behaves as all three on
- List view for the Organizations page (#428)
  - A cards/list switch in the toolbar; the list shows one row per organization with its role, destination, repository counts, last mirrored time, status, the same actions as the cards and the source and destination links, so a few dozen organizations fit on one screen
  - The choice is remembered per browser, next to the theme and time format preferences
- Incremental issue and pull request sync (#449)
  - After a complete pass, the issues and pull request passes ask GitHub only for items updated since the last one (with a 10 minute margin), so comments, pull request details, commits and files are fetched only for what changed instead of for every item on every sync
  - The watermark is stored per repository in the metadata state and only moves when a pass finishes with no failed item
  - A full pass still runs when the last one is older than 7 days, when the destination has no mirrored issues or pull requests, and after Reset metadata
- Releases mirror from Gitea and Forgejo sources, Codeberg included (#440)
  - The release mirror lists releases through the repository's own source instead of always through the GitHub API, and keeps the same release limit, asset limit, per-destination lock, tag check and retention pruning
  - Release assets are downloaded with the credentials of the host they live on, so a Gitea source uses its own token and a public one needs none
  - The release switch and its two limits are enabled for Gitea and Forgejo sources; GitLab stays code only
- Sync an organization that is already mirrored (#429)
  - The organization card menu gains Sync Organization for mirrored and failed organizations; the Mirror button only ever covered the first run
  - `POST /api/job/sync-org` re-discovers the organization's repositories from its source, mirrors the imported ones and syncs the mirrored, synced and failed ones, leaving rows another run owns alone; the organization is claimed before the response so two clicks cannot both start a run
- CSV export of repositories and organizations (#428)
  - `GET /api/repositories/export` and `GET /api/organizations/export` return the tables without the internal fields (ids, sync metadata, mirror option overrides); an Export CSV button sits in both toolbars and API keys work on both routes
- The login page can open on SSO (#438)
  - `AUTH_DEFAULT_METHOD=sso` sets the instance default, and each browser remembers the method it last signed in with; the new public `GET /api/auth/methods` tells the login page which methods exist and which to open on
- Public organizations without a source connection (#409)
  - The Add Organization dialog offers a Public only mode, the default when no source is connected: pick GitHub, GitLab or Gitea/Forgejo, optionally an instance URL, and the organization is imported anonymously
  - A tokenless source row is found or created for that provider and host and the organization is pinned to it, so attribution, locks, the scheduler and cleanup keep working per source
  - Anonymous GitHub clients keep the throttling and rate-limit backoff of authenticated ones, and the scheduler, per-repo mirror, retry, sync and recovery paths gate on the destination token instead of a source token
  - Sources with no username and no token are saved and shown as Public only, and the organizations and repositories pages work with no configured source
- Per-organization source selection for multi-source accounts
  - Organizations remember which source they import and mirror from; migration 0020 backfills the pin from each organization's repositories when they agree on one
  - Source picker in the add-organization dialog and on organization cards when more than one source is connected
  - `POST /api/sync/organization` persists `sourceId`, and `PATCH /api/organizations/:id` sets or clears it
  - The bulk import only clears a pin it created itself in the same run when a second source lists the same organization; pins set through the picker or the add dialog are kept
- Multi-source support: connect multiple source services per user (#375 follow-up)
  - Sources list on the Configuration page with add, edit and remove per source
  - Per-repository source attribution, with credentials resolved from each repository's own source
  - Per-source locking, discovery, auto import and cleanup
- Git LFS (Large File Storage) support for mirroring (#74)
  - New UI checkbox "Mirror LFS" in Mirror Options
  - Automatic LFS object transfer when enabled
  - Documentation for Gitea server LFS requirements
- Repository "ignored" status to skip specific repos from mirroring (#75)
  - Repositories can be marked as ignored to exclude from all operations
  - Scheduler automatically skips ignored repositories
- Enhanced error handling for all metadata mirroring operations
  - Individual try-catch blocks for issues, PRs, labels, milestones
  - Operations continue even if individual components fail
- Support for BETTER_AUTH_TRUSTED_ORIGINS environment variable (#63)
  - Enables access via multiple URLs (local IP + domain)
  - Comma-separated trusted origins configuration
  - Proper documentation for multi-URL access patterns
- Comprehensive fix report documentation

### Changed
- A new configuration starts with scheduling off unless `SCHEDULE_ENABLED=true`, `SCHEDULE_INTERVAL` or `GITEA_MIRROR_INTERVAL` turns it on, the same rule the environment loader uses; the built-in default schedule is the daily 22:00 clock schedule the automation card shows, so enabling from the card and the scheduler agree from the first save (#427)

### Fixed
- A GitHub rate limit no longer holds the scheduler lock until the reset (#437)
  - Every rate-limited request used to sleep for the full reset window inside the scheduler run, up to three times per request, so a large sync could keep the lock for hours while every tick logged "Scheduler is already running"; restarting was the only way out and the repositories that failed on the limit needed a manual retry
  - Waits of up to two minutes are still slept off in the request; a longer reset pauses the source instead, the run stops at the next batch or repository, the lock is released and the next run is moved to just after the reset
  - A repository whose attempt failed only because of the rate limit goes back to the status it had before, so the run after the reset picks it up on its own
- The `latest` Docker image tag no longer lags behind a release (#425)
  - A merge and the version bump that follows it land on main seconds apart; both built the image and both pushed `latest`, and on v3.36.1 the older build finished last, so `latest` carried 3.36.0 until the weekly rebuild replaced it
  - The workflow runs one build per ref at a time, `latest` is pushed only by a stable release tag build, main builds push `edge` and the short commit sha, and the security scan looks at the image the run just pushed
- The automation card shows the schedule that actually runs (#427)
  - A fresh install started with scheduling on and a plain 24 hour interval counted from first login, and the card, which only knows clock schedules, showed the 22:00 placeholder as if it were saved; the same misreport hit Docker installs with `GITEA_MIRROR_INTERVAL=8h`
  - When a plain interval is stored (from `SCHEDULE_INTERVAL`, `GITEA_MIRROR_INTERVAL` or an older version) the card says what runs and where it came from, and leaves frequency and start time unset until one is picked
  - The timezone chip shows the stored timezone instead of the browser's, and becomes a one-click switch to the browser timezone when the two differ
- Ignoring an organization stops its repositories from syncing (#429)
  - Ignore Organization only changed the organization row; its mirrored repositories kept syncing and rediscovery kept importing new ones for it
  - The organization's idle repositories are ignored with it (rows in flight or being deleted finish on their own) and restored when it is included again, mirrored ones as mirrored and the rest as imported; rediscovery skips ignored organizations
- Organization cards name the configured destination instead of always saying Gitea (#430)
- The Nix snippets in the README, NIX.md and the deployment guide import the module before enabling `services.gitea-mirror`, and put the flake input in `flake.nix` where it belongs (#426)
- Crash recovery no longer resumes a job that is still running
  - A job older than two hours was treated as interrupted even while it checkpointed every two minutes, so recovery started a second pass over the same repositories alongside the original; the age rule is gone and only a missing or stale checkpoint marks a job interrupted
  - Every completed item is now recorded in the job's checkpoint instead of one in every N, so a real resume skips exactly what was done; progress events are still throttled
  - Concurrent items completing at the same time could overwrite each other's checkpoint; job progress writes are serialized per job
  - A resumed job records a fresh start time
- The same upstream repository is no longer imported twice under two sources that point at the same host
  - Discovery decided what was new by (source, full name), so an organization pinned to a public-only github.com source and a personal github.com token source each inserted their own row for one repository, and both rows mirrored to the same destination in the same scheduler batch
  - Auto import, organization re-discovery and the two import endpoints now identify a repository by its host and full name whichever source lists it; the same name on a different host is still a separate repository
  - A scheduler pass mirrors or syncs one row per upstream repository and logs the duplicate rows it skips, so existing duplicates never run side by side
- A per-organization Mirror Destination equal to the organization's own name is kept instead of being dropped (#416)
  - The editor treated a typed value matching the organization name as "reset to default" and saved no override, which only holds under the preserve strategy; under single-org the default is the destination organization, so the repositories went there
  - The organization card now shows the default for the configured strategy in the preview, the placeholder, the helper text and the reset button, and marks any stored destination as custom
  - The repository destination column shows the organization's override as a repository's default, and pinning a repository to the value the strategy already produces is stored rather than discarded
  - Reset to Default on an organization card clears the override instead of saving the current value again
- Release assets are never duplicated on the destination (#417)
  - Gitea and Forgejo accept any number of attachments with the same name, so two mirror passes that overlapped on one repository both saw an asset as missing and both uploaded it, leaving two, three or five copies
  - Release reconciliation now runs one pass at a time per destination repository, keeps a single copy of each asset, and deletes surplus and stale copies before uploading anything
  - A sync no longer starts on a repository that is already being mirrored or synced, and the mirror path claims the repository in one statement instead of checking and then writing
  - Nothing is uploaded when the destination cannot say which assets a release already has, or when a stale copy could not be removed first
  - The next sync of an affected repository removes the surplus copies for every release that still gets its assets; releases that have dropped out of the newest-N window keep their duplicates until they are removed by hand
- Fixed metadata mirroring authentication errors (#68)
  - Changed field checking from `username` to `defaultOwner` in metadata functions
  - Added proper field validation for all metadata operations
- Fixed automatic mirroring scheduler issues (#72)
  - Improved interval parsing and error handling
- Fixed OIDC authentication 500 errors with Authentik (#73)
  - Added URL validation in Better Auth configuration
  - Prevented undefined URL errors in auth callback
- Fixed SSL certificate handling in Docker (#48)
  - NODE_EXTRA_CA_CERTS no longer gets overridden
  - Proper preservation of custom CA certificates
- Fixed reverse proxy base domain issues (#63)
  - Better handling of custom subdomains
  - Support for trusted origins configuration
- Fixed configuration persistence bugs (#49)
  - Config merging now preserves all fields
  - Retention period settings no longer reset
- Fixed sync failures with improved error handling (#51)
  - Comprehensive error wrapping for all operations
  - Better error messages and logging

### Improved
- Enhanced logging throughout metadata mirroring operations
  - Detailed success/failure messages for each component
  - Configuration details logged for debugging
- Better configuration state management
  - Proper merging of loaded configs with defaults
  - Preservation of user settings on refresh
- Updated documentation
  - Added LFS feature documentation
  - Updated README with new features
  - Enhanced CLAUDE.md with repository status definitions

### Security
- Release assets a repository's owner links by URL are no longer trusted like files on the source. Forgejo lets an owner attach an asset by `external_url`, with any address, and mirroring that repository with release mirroring on sent the source token to that address and stored the response as a release asset on the mirror. These assets now download without the token and only from public addresses, checked again on every redirect. One that points anywhere else is skipped with a warning and does not mark the sync as failed. Assets a Gitea or Forgejo instance hosts itself keep working, private repositories and instances behind another `ROOT_URL` included.
- The GitLab and GitHub destination client checks the address on every request and every redirect, not only when the destination is saved, so a name that later resolves to the cloud metadata address, or a redirect to it, is refused (GHSA-jpcv-7rgv-87p5). A destination token no longer follows a redirect to another host.
- `safeFetch` connects to the address its check saw. It looked the name up a second time for the connection, and could send the request unpinned if that second answer was a blocked address.
- The owner of a mirrored Forgejo repository could run the mirror out of memory with a release asset linked to their own server. The download read whatever that server sent, and a redirect with an endless body kept streaming after the outbound guard had given up on it, because Bun keeps reading a response whose body was cancelled. Linked assets are now capped at 512 MB and 15 minutes and skipped with a warning past either, and every response a download does not use is aborted, which is what closes its connection.

### Documentation
- Links between pages on the docs website work again. They were written as `./page.md`, which the site never served, and Cloudflare Pages answered every unknown path with the homepage, so 38 links quietly led there. Unknown paths now get a 404 page, and a CI check (`scripts/check-docs-links.ts`) fails on links to missing pages or headings
- Corrected pages that said the wrong thing: new repository notifications exist; Gitea and Forgejo sources do mirror releases; the NixOS example imports the module; a bare metal install needs both secrets set and kept; Compose does not run commands in `.env`; the data directory also holds `mirrors/` and `tmp/release-assets/`; Gitea's mirror interval takes hours and minutes, not days, and its default is 8h; the first run steps name the real buttons instead of a setup wizard; OAuth applications are API only; sign-up stays open with `AUTH_ALLOW_SIGNUP`; the MCP bridge is not on npm yet, so it is built from a checkout
- Removed environment variables that were documented but never used: `GITHUB_TYPE`, `GITEA_CREATE_ORG`, `GITEA_FORK_STRATEGY`, `GITEA_TEMPLATE_OWNER`, `GITEA_TEMPLATE_REPO`, `SCHEDULE_TIMEOUT`, `SCHEDULE_LOG_LEVEL`, `SCHEDULE_AUTO_RETRY`, `SCHEDULE_RETRY_ATTEMPTS`, `SCHEDULE_RETRY_DELAY`, `SCHEDULE_CLEANUP_BEFORE_MIRROR`, `SCHEDULE_NOTIFY_ON_FAILURE`, `SCHEDULE_NOTIFY_ON_SUCCESS`, `NON_MIRROR_STRATEGY`, `ORG_CREATION_RETRIES`, `ORG_CREATION_RETRY_DELAY`, `SEQUENTIAL_ORG_CREATION`, `REPO_BATCH_SIZE` and `SYNC_TIMEOUT`. `GITEA_PRESERVE_VISIBILITY` only affects GitHub and GitLab destinations, and `MIRROR_METADATA` from the environment does not switch the four metadata options off
- New docs pages: Tokens and permissions (the scopes each source and destination needs and why), Repositories and organizations (moving mirrors, mirror options, issue state, CSV export, the Storage and Activity pages), Reverse proxy and URLs, Backups and upgrades, and Troubleshooting for the questions that come up most. The docs navigation is regrouped into Getting started, Using it, Operating and Reference, with previous and next links on each page
- The API page now lists every endpoint the app offers to scripts, including moving mirrors, CSV export, retry, organization sync, approving held syncs and status changes. `docs/API.md` points to it, and so does the link on the API Keys card
- `PUBLIC_BETTER_AUTH_URL` is no longer suggested anywhere. It is only read while building from source and fixed into that build, so setting it on a running container did nothing, and `.env.example` no longer sets it
- GitHub tokens are documented with `repo` and `read:org`, which is all the app uses. Reconcile's moved group is documented
- The README is a short overview with a quick start and links to the website. The pages in `docs/` that repeated the website, plus `NIX.md` and `certs/README.md`, now point to it, after their remaining facts moved there
- More pages corrected against the code: SAML sign-in does not work from the UI and is marked so, with the right ACS URL; the OIDC provider's discovery URL is under `/api/auth`; force-push protection does not pause Gitea's own mirror schedule; `/app/certs` must be writable, since a read-only mount stops the container, and a read-only setup through `NODE_EXTRA_CA_CERTS` is described, along with git not reading that variable; the Nix `gitea-mirror-db` helper is no longer suggested; `DESTINATION_PROVIDER` is not checked against a locked destination; and several environment variable rows, including `SCHEDULE_CONCURRENT`, `SCHEDULE_ONLY_MIRROR_UPDATED`, `SKIP_STARRED_ISSUES` and `HEADER_AUTH_ALLOWED_DOMAINS`, now say what the code does
- CI checks the links in every markdown file in the repository, and fails when the app reads an environment variable the reference page does not list, or the page lists one nothing reads
- The contributor docs (`CONTRIBUTING.md`, `CLAUDE.md`, the development workflow, SSO testing and Nix packaging notes) match the code again, and the two shutdown and recovery notes are merged into `docs/SHUTDOWN_AND_RECOVERY.md`

## [3.7.1] - 2025-09-14

### Fixed
- Cleanup archiving for mirror repositories now works reliably (refs #84; awaiting user confirmation).
  - Gitea rejects names violating the AlphaDashDot rule; archiving a mirror now uses a sanitized rename strategy (`archived-<name>`), with a timestamped fallback on conflicts or validation errors.
  - Owner resolution during cleanup no longer uses the GitHub owner by mistake. It prefers `mirroredLocation`, falls back to computed Gitea owner via configuration, and verifies location with a presence check to avoid `GetUserByName` 404s.
- Repositories UI crash resolved when cleanup marked repos as archived.
  - Added `"archived"` to repository/job status enums, fixing Zod validation errors on the Repositories page.

### Changed
- Archiving logic for mirror repos is non-destructive by design: data is preserved, repo is renamed with an archive marker, and mirror interval is reduced (best‑effort) to minimize sync attempts.
- Cleanup service updates DB to `status: "archived"` and `isArchived: true` on successful archive path.

### Notes
- This release addresses the scenario where a GitHub source disappears (deleted/banned), ensuring Gitea backups are preserved even when using `CLEANUP_DELETE_IF_NOT_IN_GITHUB=true` with `CLEANUP_ORPHANED_REPO_ACTION=archive`.
- No database migration required.

## [3.2.6] - 2025-08-09

### Fixed
- Added missing release asset mirroring functionality (APK, ZIP, Binary files)
- Release assets (attachments) are now properly downloaded from GitHub and uploaded to Gitea
- Fixed missing metadata component configuration checks

### Added
- Full support for mirroring release assets/attachments
- Debug logging for metadata component configuration to help troubleshoot mirroring issues
- Download and upload progress logging for release assets

### Improved
- Enhanced release mirroring to include all associated binary files and attachments
- Better visibility into which metadata components are enabled/disabled
- More detailed logging during the release asset transfer process

### Notes
This patch adds the missing functionality to mirror release assets (APK, ZIP, Binary files, etc.) that was reported in Issue #68. Previously only release metadata was being mirrored, now all attachments are properly transferred to Gitea.

## [3.2.5] - 2025-08-09

### Fixed
- Fixed critical authentication issue in releases mirroring that was still using encrypted tokens
- Added missing repository existence check for releases mirroring function
- Fixed "user does not exist [uid: 0]" error specifically affecting GitHub releases synchronization

### Improved
- Enhanced releases mirroring with duplicate detection to avoid errors on re-runs
- Better error handling and logging for release operations with [Releases] prefix
- Added individual release error handling to continue mirroring even if some releases fail

### Notes
This patch completes the authentication fixes started in v3.2.4, specifically addressing the releases mirroring function that was accidentally missed in the previous update.

## [3.2.4] - 2025-08-09

### Fixed
- Fixed critical authentication issue causing "user does not exist [uid: 0]" errors during metadata mirroring (Issue #68)
- Fixed inconsistent token handling across Gitea API calls
- Fixed metadata mirroring functions attempting to operate on non-existent repositories
- Fixed organization creation failing silently without proper error messages

### Added
- Pre-flight authentication validation for all Gitea operations
- Repository existence verification before metadata mirroring
- Graceful fallback to user account when organization creation fails due to permissions
- Authentication validation utilities for debugging configuration issues
- Diagnostic test scripts for troubleshooting authentication problems

### Improved
- Enhanced error messages with specific guidance for authentication failures
- Better identification and logging of permission-related errors
- More robust organization creation with retry logic and better error handling
- Consistent token decryption across all API operations
- Clearer error reporting for metadata mirroring failures

### Security
- Fixed potential exposure of encrypted tokens in API calls
- Improved token handling to ensure proper decryption before use

## [3.2.0] - 2025-07-31

### Fixed
- Fixed Zod validation error in activity logs by correcting invalid "success" status values to "synced"
- Resolved activity fetch API errors that occurred after mirroring operations

### Changed
- Improved error handling and validation for mirror job status tracking
- Enhanced reliability of organization creation and mirroring processes

### Internal
- Consolidated Gitea integration modules for better maintainability
- Improved test coverage for mirror operations

## [3.1.1] - 2025-07-30

### Fixed
- Various bug fixes and stability improvements

## [3.1.0] - 2025-07-21

### Added
- Support for GITHUB_EXCLUDED_ORGS environment variable to filter out specific organizations during discovery
- New textarea UI component for improved form inputs in configuration

### Fixed
- Fixed test failures related to mirror strategy configuration location
- Corrected organization repository routing logic for different mirror strategies
- Fixed starred repositories organization routing bug
- Resolved SSO and OIDC authentication issues

### Improved
- Enhanced organization configuration for better repository routing control
- Better handling of mirror strategies in test suite
- Improved error handling in authentication flows

## [3.0.0] - 2025-07-17

### 🔴 Breaking Changes
- **Authentication System Overhaul**: Migrated from JWT to Better Auth session-based authentication
- **Login Method Changed**: Users now log in with email instead of username
- **Environment Variables**: `JWT_SECRET` renamed to `BETTER_AUTH_SECRET`, new `BETTER_AUTH_URL` required
- **API Endpoints**: Authentication endpoints moved from `/api/auth/login` to `/api/auth/[...all]`

### Added
- **Token Encryption**: All GitHub and Gitea tokens now encrypted with AES-256-GCM
- **SSO/OIDC Support**: Enterprise authentication with OAuth providers (Google, Azure AD, Okta, Authentik, etc.)
- **Header Authentication**: Support for reverse proxy authentication headers (Authentik, Authelia, Traefik Forward Auth)
- **OAuth Provider**: Gitea Mirror can act as an OIDC provider for other applications
- **Automated Migration**: Docker containers auto-migrate from v2 to v3
- **Session Management**: Improved security with session-based authentication
- **Database Migration System**: Drizzle Kit for better schema management
- **Zod v4 Compatibility**: Updated to Zod v4 for schema validation

### Improved
- **Security**: Enhanced error handling and security practices throughout
- **Documentation**: Comprehensive migration guide for v2 to v3 upgrade
- **User Management**: Better Auth provides improved user lifecycle management
- **Database Schema**: Optimized with proper indexes and relationships
- **Password Hashing**: Using bcrypt via Better Auth for secure password storage

### Fixed
- Mirroring issues for starred repositories
- Various security vulnerabilities in authentication system
- Improved error handling across all API endpoints

### Migration Required
- All users must re-authenticate after upgrade
- Existing tokens will be automatically encrypted
- Database schema updates applied automatically
- See [Migration Guide](https://github.com/RayLabsHQ/gitea-mirror/blob/1e06e2bd4b7e034ed43187817fbdbb07865da3b3/MIGRATION_GUIDE.md) for detailed instructions

## [2.22.0] - 2025-07-07

### Added
- Comprehensive mobile and responsive design support across the entire application
- New drawer UI component for enhanced mobile navigation
- Mobile-specific layouts for major components (ActivityLog, Header, Organization, Repository)
- Mobile screenshots in documentation showcasing responsive design

### Improved
- Enhanced mobile user experience with optimized layouts for smaller screens
- Updated organization list cards with better mobile responsiveness
- Better touch interaction support throughout the application

### Fixed
- Type definition issues resolved
- Removed unnecessary console.log statements

### Documentation
- Updated README with mobile usage instructions and screenshots
- Added mobile-specific documentation sections

## [2.20.1] - 2025-07-07

### Fixed
- Fixed mixed mode organization strategy not persisting after page refresh
  - Added missing "mixed" case handler in GiteaConfigForm component
  - Enhanced getMirrorStrategy function to properly detect mixed mode configuration
- Updated dependencies to latest versions

## [2.20.0] - 2025-07-07

### Changed
- **BREAKING**: Repository moved from `arunavo4/gitea-mirror` to `RayLabsHQ/gitea-mirror`
- Docker images now hosted at `ghcr.io/raylabshq/gitea-mirror`
- Updated all repository references and links to new organization
- License changed from MIT to GNU General Public License v3.0

### Fixed
- Updated GitHub API endpoint for version checking to use new repository location
- Corrected all documentation references to point to RayLabsHQ organization

### Security
- Removed test security script after confirming vulnerability resolution
- Updated base Docker image to version 1.2.18-alpine

### Documentation
- Added repository migration notice in README
- Updated quickstart guide with new repository URLs
- Updated LXC deployment documentation with new repository location

## [2.18.0] - 2025-06-24

### Added
- Fourth organization strategy "Mixed Mode" that combines aspects of existing strategies
  - Personal repositories go to a single configurable organization
  - Organization repositories preserve their GitHub organization structure
- "Override Options" info button in Organization Strategy component explaining customization features
  - Organization overrides via edit buttons on organization cards
  - Repository overrides via inline destination editor
  - Starred repositories behavior and priority hierarchy

### Improved
- Simplified mixed strategy implementation to reuse existing database fields
- Enhanced organization strategy UI with comprehensive override documentation
- Better visual indicators for the new mixed strategy with orange color theme

## [2.17.0] - 2025-06-24

### Added
- Custom destination control for individual repositories with inline editing
- Organization-level destination overrides with visual destination editor
- Personal repositories organization override configuration option
- Visual indicators for starred repositories (⭐ icon) in repository list
- Repository-level destination override API endpoint
- Destination customization priority hierarchy system
- "View on Gitea" buttons for organizations with smart tooltip states

### Changed
- Enhanced repository table with destination column showing both GitHub org and Gitea destination
- Updated organization cards to display custom destinations with visual indicators
- Improved getGiteaRepoOwnerAsync to support repository-level destination overrides

### Improved
- Better visual feedback for custom destinations with badges and inline editing
- Enhanced user experience with hover-based edit buttons
- Comprehensive destination customization documentation in README

## [2.16.3] - 2025-06-20

### Added
- Custom 404 error page with helpful navigation links
- HoverCard components for better UX in configuration forms

### Improved
- Replaced popover components with hover cards for information tooltips
- Enhanced user experience with responsive hover interactions

## [2.16.2] - 2025-06-17

### Added
- Bulk actions for repository management with selection support

### Improved
- Enhanced organization card display with status badges and improved layout

## [2.16.1] - 2025-06-17

### Improved
- Improved repository owner handling and mirror strategy in Gitea integration
- Updated label for starred repositories organization for consistency

## [2.16.0] - 2025-06-17

### Added
- Enhanced OrganizationConfiguration component with improved layout and metadata options
- New GitHubMirrorSettings component with better organization and flexibility
- Enhanced starred repositories content selection and improved layout

### Improved
- Enhanced configuration interface layout and spacing across multiple components
- Streamlined OrganizationStrategy component with cleaner imports and better organization
- Improved responsive layout for larger screens in configuration forms
- Better icon usage and clarity in configuration components
- Enhanced tooltip descriptions and component organization
- Improved version comparison logic in health API
- Enhanced issue mirroring logic for starred repositories

### Fixed
- Fixed mirror to single organization functionality
- Resolved organization strategy layout issues
- Cleaned up unused imports across multiple components

### Refactored
- Simplified component structures by removing unused imports and dependencies
- Enhanced layout flexibility in GitHubConfigForm and GiteaConfigForm components
- Improved component organization and code clarity
- Removed ConnectionsForm and useMirror hook for better code organization

## [2.14.0] - 2025-06-17

### Added
- Enhanced UI components with @radix-ui/react-accordion dependency for improved configuration interface

### Fixed
- Mirror strategies now properly route repositories based on selected strategy
- Starred repositories now correctly go to the designated starred repos organization
- Organization routing for single-org and flat-user strategies

### Improved
- Documentation now explains all three mirror strategies (preserve, single-org, flat-user)
- Added detailed mirror strategy configuration guide
- Updated CLAUDE.md with mirror strategy architecture information
- Enhanced Docker Compose development configuration

## [2.13.2] - 2025-06-15

### Improved
- Enhanced documentation design and layout
- Updated README with improved formatting and content

## [2.13.1] - 2025-06-15

### Added
- Docker Hub authentication for Docker Scout security scanning
- Comprehensive Docker workflow consolidation with build, push & security scan

### Improved
- Enhanced CI/CD pipeline reliability with better error handling
- Updated Bun base image to latest version for improved security
- Migrated from Trivy to Docker Scout for more comprehensive security scanning
- Enhanced Docker workflow with wait steps for image availability

### Fixed
- Docker Scout action integration issues and image reference problems
- Workflow reliability improvements with proper error handling
- Security scanning workflow now continues on security issues without failing the build

### Changed
- Updated package dependencies to latest versions
- Consolidated multiple Docker workflows into single comprehensive workflow
- Enhanced security scanning with Docker Scout integration

## [2.13.0] - 2025-06-15

### Added
- Enhanced Configuration Interface with collapsible components and improved organization strategy UI
- Wiki Mirroring Support in configuration settings
- Auto-Save Functionality for all config forms, eliminating manual save buttons
- Live Refresh functionality with configuration status hooks and enhanced UI components
- Enhanced API Config Handling with mapping functions for UI and database structures
- Secure Error Responses with createSecureErrorResponse for consistent error handling
- Automatic Database Cleanup feature with configuration options and API support
- Enhanced Job Recovery with improved database schema and recovery mechanisms
- Fork tags to repository UI and enhanced organization cards with repository breakdown
- Skeleton loaders and better loading state management across the application

### Improved
- Navigation context and component loading states across the application
- Card components alignment and styling consistency
- Error logging and structured error message parsing
- HTTP client standardization across the application
- Database initialization and management processes
- Visual consistency with updated icons and custom logo integration

### Fixed
- Repository mirroring status inconsistencies
- Organizations getting stuck on mirroring status when empty
- JSON parsing errors and improved error handling
- Broken documentation links in README
- Various UI contrast and alignment issues

### Changed
- Migrated testing framework to Bun and updated test configurations
- Implemented graceful shutdown and enhanced job recovery capabilities
- Replaced SiGitea icons with custom logo
- Updated various dependencies for improved stability and performance

## [2.12.0] - 2025-01-27

### Fixed
- Fixed SQLite "no such table: mirror_jobs" error during application startup
- Implemented automatic database table creation during database initialization
- Resolved database schema inconsistencies between development and production environments

### Improved
- Enhanced database initialization process with automatic table creation and indexing
- Added comprehensive error handling for database table creation
- Integrated database repair functionality into application startup for better reliability

## [2.5.3] - 2025-05-22

### Added
- Enhanced JWT_SECRET handling with auto-generation and persistence for improved security
- Updated Proxmox LXC deployment instructions and replaced deprecated script

## [2.5.2] - 2024-11-22

### Fixed
- Fixed version information in health API for Docker deployments by setting npm_package_version environment variable in entrypoint script

## [2.5.1] - 2024-10-01

### Fixed
- Fixed Docker entrypoint script to prevent unnecessary `bun install` on container startup
- Removed redundant dependency installation in Docker containers for pre-built images
- Fixed "PathAlreadyExists" errors during container initialization

### Changed
- Improved database initialization in Docker entrypoint script
- Added additional checks for TypeScript versions of database management scripts

## [2.5.0] - 2024-09-15

Initial public release with core functionality:

### Added
- GitHub to Gitea repository mirroring
- User authentication and management
- Dashboard with mirroring statistics
- Configuration management for mirroring settings
- Support for organization mirroring
- Automated mirroring with configurable schedules
- Docker multi-architecture support (amd64, arm64)
- LXC container deployment scripts
