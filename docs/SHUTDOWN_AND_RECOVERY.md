# Shutdown and recovery

What happens to running mirror jobs when the app stops, crashes or restarts. This replaces the old `GRACEFUL_SHUTDOWN.md` and `RECOVERY_IMPROVEMENTS.md`.

## Overview

- A clean stop (SIGTERM, SIGINT, SIGHUP) runs a graceful shutdown that saves the state of running jobs, within 30 seconds.
- A crash, a hard kill or a clean stop leaves jobs marked as in progress. The server resumes them as soon as it starts.
- A job resumed 3 times in a row without finishing a single item is marked `failed` instead of being resumed again, see [the resume limit](#the-resume-limit).
- Repositories left in `mirroring` or `syncing` are reset to `failed`, so the scheduler or a manual sync picks them up again.

## Startup order

- **Docker:** the entrypoint runs the env config loader, then `scripts/startup-recovery.ts`, then `scripts/repair-mirrored-repos.ts --startup`, then starts the server.
- **Nix:** the wrapper runs the same three steps before the server.
- **`bun run start` and `bun run dev`:** none of that runs up front. The middleware starts the shutdown manager, the env config loader, recovery, the scheduler and the cleanup services on the first HTTP request. In Docker, the health check makes that request within seconds.

## Shutdown

`src/lib/signal-handlers.ts` turns SIGTERM, SIGINT and SIGHUP into a graceful shutdown. SIGHUP does a full shutdown, not a reload. An uncaught exception also starts one and then exits with code 1.

`src/lib/shutdown-manager.ts` then:

1. Saves each running job, with up to 10 seconds per job. The job stays marked `inProgress`, with its checkpoint updated and a message saying it will resume on restart. Until #564 the flag was cleared, so a job stopped cleanly was never resumed.
2. Runs the registered shutdown callbacks, which stop the scheduler, the cleanup service and the repository cleanup service.
3. Logs a database close step, which does nothing else today.
4. Exits with code 0 for a signal, or 1 after a crash.

The whole shutdown is capped at 30 seconds, after which the process exits with code 1. Both limits are fixed in code; there is no environment variable for them.

In Docker, the entrypoint forwards SIGTERM to the app and waits for it.

## Stop timeouts by platform

The platform has to wait longer than the 30 second shutdown, or it kills the process halfway.

| Platform | Default wait | What to do |
| --- | --- | --- |
| Docker and Compose | 10 seconds | Add `stop_grace_period: 35s` to the service, or use `docker stop -t 35`. The compose files in this repository do not set it. |
| Helm | 60 seconds (`deployment.terminationGracePeriodSeconds`) | Nothing. |
| NixOS module | 30 seconds (`TimeoutStopSec`) | Usually enough. |

## What counts as interrupted

`src/lib/interrupted-job-detection.ts` decides which jobs recovery resumes. A job is interrupted when:

- it is still marked `inProgress`, and
- its last checkpoint is older than the cutoff, or it has none and started before the cutoff.

The cutoff is the later of 10 minutes ago and the start of the server process (`src/lib/process-start.ts`, taken from `performance.timeOrigin`). With SQLite there is one app process, so a job last touched before it started was left by a process that is gone, and is resumed at once (#564). The 10 minute window still covers a job this process started that stopped moving. Times in `mirror_jobs` are whole seconds, so the process start is rounded down to its second; otherwise a job started in the first second would look older than the process.

Running jobs refresh their checkpoint every 2 minutes as a heartbeat, so a live job is never picked up, however long it runs. An older rule also resumed any job started more than 2 hours ago; it was removed because it resumed jobs that were still running and duplicated their work (#417).

Separately, in-progress jobs that started more than 24 hours ago are marked `failed` as stale (`src/lib/recovery.ts`).

## Recovery passes

- **At startup** (Docker and Nix): `scripts/startup-recovery.ts` resets stuck repository statuses (below) and logs the interrupted jobs it finds, then exits 0, or 1 on an error. It does not resume them. It used to, in its own process, and exited after 30 seconds with the job half done and a fresh checkpoint, so the server only picked it up 10 minutes later (#564). `--force` and `--timeout` are still accepted and do nothing.
- **On requests:** the middleware runs recovery when no run is in flight, with 2 retries 3 seconds apart. A request waits at most 15 seconds for it, and the run continues in the background after that. `initializeRecovery()` skips a run when the last attempt was less than 5 minutes ago.

Each interrupted job resumes the repositories or organizations it had not finished. A job that cannot be resumed is marked `failed`.

## The resume limit

When the resumed work itself takes the app down, for example by running it out of memory, every start resumed the same job and went down again (#564). `mirror_jobs.resume_attempts` counts resumes in a row that finished no item. Recovery adds one each time it resumes a job, and finishing an item sets it back to 0. A job that reaches `MAX_RESUMES_WITHOUT_PROGRESS` (3) is marked `failed`, with a message saying it stopped resuming, instead of being resumed again. Its repositories are reset by the stuck status reset and mirrored again by the next scheduled run or a manual sync.

## Stuck repository statuses

`src/lib/stuck-status-recovery.ts` resets repositories and organizations left in an in-flight status (`mirroring`, `syncing`) by an interrupted run to `failed`, with a message saying why (#339). It runs on every scheduler tick (once a minute), during recovery and from the startup script. Without it those rows would stay stuck, since the scheduler skips in-flight statuses and the UI disables their buttons.

## Health endpoint

`GET /api/health` includes a `recovery` object with the recovery status and the number of jobs needing recovery. When jobs need recovery and none is running, the overall status is `degraded`. It reports nothing about shutdowns.

## Scripts and tests

| Command | What it does |
| --- | --- |
| `bun run startup-recovery` | The startup pass described above: resets stuck statuses and lists interrupted jobs. |
| `bun run test-recovery` | Writes fake interrupted jobs into the database and recovers them. `--cleanup` removes them. It uses the real database, so run it against a scratch copy. |
| `bun run test-shutdown` | Exercises the graceful shutdown with a test job. `--cleanup` removes it. Same warning about the database. |
| `bun scripts/fix-interrupted-jobs.ts` | Marks interrupted jobs as failed by hand. |

Unit tests: `src/lib/shutdown-manager.test.ts`, `src/lib/interrupted-job-detection.test.ts`, `src/lib/recovery-restart-loop.test.ts`, `src/lib/stuck-status-recovery.test.ts`, `src/lib/orchestrator-resume-after-startup.test.ts`.

## Troubleshooting

- **Jobs are cut off when the container stops.** Docker's 10 second default is shorter than the 30 second shutdown. Set `stop_grace_period`.
- **A repository shows `failed` with a message about an interrupted run.** The stuck status reset did that after a restart. Sync it, or wait for the next scheduled run.
- **A job shows `failed` with "Stopped resuming after 3 restarts in a row without progress".** Each resume of it ended with the app going down. Check the logs and the memory limit around those restarts, then sync the remaining repositories.
- **`/api/health` says `degraded`.** Interrupted jobs are waiting for recovery. It runs on the next request when the 5 minute throttle allows; check the logs for `Recovery attempt` lines.
