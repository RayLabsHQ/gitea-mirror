/**
 * Moving existing mirrors to where the current settings put them (#550):
 * the run. It checks again right before acting, creates the organizations
 * the moves need, then transfers (and renames) one mirror at a time,
 * recording where each mirror really is after every step, so a failure
 * halfway never leaves the record pointing at the wrong place. Mirrors that
 * cannot move stay where they are and keep syncing.
 *
 * One run per user at a time. Its progress lives in memory for the dialog
 * to poll; the activity log keeps the outcome.
 */

import { and, eq } from "drizzle-orm";
import { db, repositories } from "@/lib/db";
import type { Repository } from "@/lib/db/schema";
import type { Config } from "@/types/config";
import { HttpError, httpRequest } from "@/lib/http-client";
import { decryptConfigTokens } from "@/lib/utils/config-encryption";
import { transferGiteaRepo, type GiteaTransferResult } from "@/lib/gitea-enhanced";
import { createMirrorJob } from "@/lib/helpers";
import { ensureDestinationOwner } from "@/lib/destination-transfer-service";
import { ownerLogin, splitLocation } from "@/lib/destination-transfer";
import {
  giteaPlacementDeps,
  previewPlacement,
  scanUserPlacement,
} from "@/lib/mirror-placement-service";
import type { PlacementPreview, PlannedMove } from "@/lib/mirror-placement";

export type PlacementItemStatus =
  | "waiting"
  | "moving"
  | "moved"
  | "recorded"
  | "pending"
  | "failed"
  | "skipped";

export interface PlacementRunItem {
  id: string;
  fullName: string;
  from: string;
  to: string;
  status: PlacementItemStatus;
  message?: string;
}

export interface PlacementRunState {
  state: "checking" | "running" | "done";
  rename: boolean;
  startedAt: string;
  finishedAt?: string;
  items: PlacementRunItem[];
  /** Set when the run stopped early. */
  stoppedBecause?: string;
}

/** The destination calls a run makes; injectable for tests. */
export interface PlacementRunDeps {
  ensureOwner: (owner: string) => Promise<void>;
  transfer: (owner: string, name: string, newOwner: string) => Promise<GiteaTransferResult>;
  rename: (owner: string, name: string, newName: string) => Promise<void>;
  record: (id: string, location: string) => Promise<void>;
  rowStatus: (id: string) => Promise<string | null>;
  log: (args: { id: string; fullName: string; message: string; details: string; failed?: boolean }) => Promise<void>;
  /** The run's summary line in the activity log. */
  logRun: (args: { message: string; details: string; failed: boolean }) => Promise<void>;
  /** The plan as it stands now: the preview, worked out again. */
  replan: (rename: boolean) => Promise<PlacementPreview>;
}

const RUN_CONCURRENCY = 2;
/** Unexpected destination errors in a row before the run stops. */
const MAX_CONSECUTIVE_ERRORS = 3;
const BUSY_STATUSES = new Set(["mirroring", "syncing", "deleting"]);

const runs = new Map<string, PlacementRunState>();

export function placementRunState(userId: string): PlacementRunState | null {
  return runs.get(userId) ?? null;
}

export class PlacementRunBusyError extends Error {
  constructor() {
    super("Mirrors are already being moved");
    this.name = "PlacementRunBusyError";
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the destination said, in words a person can act on. */
function failureText(error: unknown, step: "transfer" | "rename", target: string): { text: string; unexpected: boolean } {
  if (error instanceof HttpError) {
    if (error.status === 422 || error.status === 409) {
      return { text: `${target} was taken since you checked.`, unexpected: false };
    }
    if (error.status === 403) {
      return { text: `The destination refused the ${step}: your account is not allowed to.`, unexpected: false };
    }
    if (error.status === 404) {
      return { text: `The destination could not find the repository any more.`, unexpected: false };
    }
    return { text: `The destination answered ${error.status} to the ${step}.`, unexpected: true };
  }
  return { text: `The ${step} failed: ${describe(error)}`, unexpected: true };
}

/** The real calls, against the configured destination. */
export function giteaRunDeps(userId: string, config: Partial<Config>): PlacementRunDeps {
  const base = `${config.giteaConfig?.url ?? ""}/api/v1`;
  const token = decryptConfigTokens(config as Config).giteaConfig?.token ?? "";
  return {
    ensureOwner: (owner) => ensureDestinationOwner({ config, owner }),
    transfer: (owner, name, newOwner) => transferGiteaRepo({ config, owner, repoName: name, newOwner }),
    rename: async (owner, name, newName) => {
      await httpRequest(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { Authorization: `token ${token}` },
        body: JSON.stringify({ name: newName }),
        redirect: "manual",
      });
    },
    record: async (id, location) => {
      const [row] = (await db
        .select({ status: repositories.status })
        .from(repositories)
        .where(and(eq(repositories.userId, userId), eq(repositories.id, id)))
        .limit(1)) as Array<Pick<Repository, "status">>;
      await db
        .update(repositories)
        .set({
          mirroredLocation: location,
          // A row that failed because its mirror was not where the app
          // looked is healthy again once the app knows where it is.
          ...(row?.status === "failed" ? { status: "mirrored", errorMessage: null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(repositories.userId, userId), eq(repositories.id, id)));
    },
    rowStatus: async (id) => {
      const [row] = await db
        .select({ status: repositories.status })
        .from(repositories)
        .where(and(eq(repositories.userId, userId), eq(repositories.id, id)))
        .limit(1);
      return row?.status ?? null;
    },
    log: async ({ id, fullName, message, details, failed }) => {
      await createMirrorJob({
        userId,
        repositoryId: id,
        repositoryName: fullName.split("/").pop() ?? fullName,
        message,
        details,
        status: failed ? "failed" : "mirrored",
        skipNotification: true,
      });
    },
    logRun: async ({ message, details, failed }) => {
      await createMirrorJob({ userId, message, details, status: failed ? "failed" : "mirrored", skipNotification: true });
    },
    replan: async (rename) =>
      previewPlacement({
        scan: await scanUserPlacement(userId, config),
        config,
        rename,
        deps: giteaPlacementDeps(config),
      }),
  };
}

/** Carry out one planned move. Records the location after each step. */
export async function executeMove(move: PlannedMove, deps: PlacementRunDeps): Promise<{ status: PlacementItemStatus; message: string; unexpected?: boolean }> {
  const from = splitLocation(move.from)!;
  const to = splitLocation(move.to)!;

  if (move.kind === "record") {
    await deps.record(move.id, move.to);
    await deps.log({
      id: move.id,
      fullName: move.fullName,
      message: `Switched the mirror of ${move.fullName} to ${move.to} (was ${move.from})`,
      details: move.note ?? `Was at ${move.from}.`,
    });
    return { status: "recorded", message: move.note ?? `Now recorded at ${move.to}.` };
  }

  const status = await deps.rowStatus(move.id);
  if (status && BUSY_STATUSES.has(status)) {
    return { status: "skipped", message: "A sync started on it in the meantime. Check again once it finishes." };
  }

  let at = { ...from };
  const where = () => `${at.owner}/${at.name}`;

  if (move.renamed && move.order === "rename-first") {
    try {
      await deps.rename(at.owner, at.name, to.name);
    } catch (error) {
      const { text, unexpected } = failureText(error, "rename", `${at.owner}/${to.name}`);
      return { status: "failed", message: `${text} Nothing was changed.`, unexpected };
    }
    at = { owner: at.owner, name: to.name };
    await deps.record(move.id, where());
  }

  let result: GiteaTransferResult;
  try {
    result = await deps.transfer(at.owner, at.name, to.owner);
  } catch (error) {
    const { text, unexpected } = failureText(error, "transfer", `${to.owner}/${at.name}`);
    const changed = where() !== move.from ? ` It was renamed to ${where()} and stays there.` : " Nothing was changed.";
    return { status: "failed", message: `${text}${changed}`, unexpected };
  }

  if (result.pending) {
    await deps.log({
      id: move.id,
      fullName: move.fullName,
      message: `Asked the destination to transfer the mirror of ${move.fullName} to ${to.owner}`,
      details: `Waiting for an owner of ${to.owner} to accept. The mirror stays at ${where()} and keeps syncing until then.`,
    });
    return {
      status: "pending",
      message: `Waiting for an owner of ${to.owner} to accept. It keeps syncing at ${where()} until then.`,
    };
  }

  at = { owner: ownerLogin(result.repo) || to.owner, name: result.repo?.name || at.name };
  await deps.record(move.id, where());

  if (move.renamed && move.order === "transfer-first" && at.name !== to.name) {
    try {
      await deps.rename(at.owner, at.name, to.name);
      at = { owner: at.owner, name: to.name };
      await deps.record(move.id, where());
    } catch (error) {
      const { text } = failureText(error, "rename", `${at.owner}/${to.name}`);
      await deps.log({
        id: move.id,
        fullName: move.fullName,
        message: `Moved the mirror of ${move.fullName} to ${where()}, but could not rename it`,
        details: `${text} Was at ${move.from}.`,
        failed: true,
      });
      return { status: "moved", message: `Moved to ${where()}, but not renamed: ${text}` };
    }
  }

  await deps.log({
    id: move.id,
    fullName: move.fullName,
    message: `Moved the mirror of ${move.fullName} from ${move.from} to ${where()}`,
    details: `Was at ${move.from}.`,
  });
  return { status: "moved", message: `Now at ${where()}.` };
}

/**
 * Move the mirrors the user confirmed. `moves` are the ids and targets the
 * dialog showed; each is checked again and only moved if the check still
 * gives the same target, so nothing moves somewhere the user did not see.
 */
export async function startPlacementRun({
  userId,
  config,
  rename,
  moves,
  deps,
}: {
  userId: string;
  config: Partial<Config>;
  rename: boolean;
  moves: Array<{ id: string; to: string }>;
  deps?: PlacementRunDeps;
}): Promise<{ done: Promise<PlacementRunState> }> {
  const current = runs.get(userId);
  if (current && current.state !== "done") throw new PlacementRunBusyError();

  const state: PlacementRunState = {
    state: "checking",
    rename,
    startedAt: new Date().toISOString(),
    items: moves.map((move) => ({ id: move.id, fullName: "", from: "", to: move.to, status: "waiting" })),
  };
  runs.set(userId, state);
  const run = deps ?? giteaRunDeps(userId, config);

  const done = (async () => {
    try {
      const plan = await run.replan(rename);
      const planned = new Map(plan.moves.map((move) => [move.id, move]));
      const blocked = new Map(plan.blocked.map((entry) => [entry.id, entry]));
      const skipped = new Map(plan.skipped.map((entry) => [entry.id, entry]));

      const todo: Array<{ item: PlacementRunItem; move: PlannedMove }> = [];
      for (const item of state.items) {
        const move = planned.get(item.id);
        if (move && move.to.toLowerCase() === item.to.toLowerCase()) {
          Object.assign(item, { fullName: move.fullName, from: move.from, to: move.to });
          todo.push({ item, move });
          continue;
        }
        const stuck = blocked.get(item.id);
        const left = skipped.get(item.id);
        Object.assign(item, {
          fullName: move?.fullName ?? stuck?.fullName ?? left?.fullName ?? item.id,
          from: move?.from ?? stuck?.from ?? left?.from ?? "",
          status: "skipped" as const,
          message: move
            ? `Its target changed to ${move.to} since you checked. Check again.`
            : stuck
              ? `Changed since you checked: ${stuck.reason} ${stuck.hint ?? ""}`.trim()
              : left
                ? `Left out: ${left.reason}.`
                : "Already in place.",
        });
      }

      state.state = "running";

      // The organizations first, once each: if one cannot be created, its
      // mirrors are not touched.
      const ownerFailures = new Map<string, string>();
      const newOwners = [...new Set(todo.filter(({ move }) => move.kind === "move" && move.ownerState === "new-organization").map(({ move }) => splitLocation(move.to)!.owner))];
      for (const owner of newOwners) {
        try {
          await run.ensureOwner(owner);
        } catch (error) {
          ownerFailures.set(owner.toLowerCase(), describe(error));
        }
      }

      let consecutiveErrors = 0;
      let next = 0;
      const worker = async () => {
        while (next < todo.length) {
          const { item, move } = todo[next++];
          if (state.stoppedBecause) {
            Object.assign(item, { status: "skipped", message: "Not started: the run stopped." });
            continue;
          }
          const ownerError = ownerFailures.get(splitLocation(move.to)!.owner.toLowerCase());
          if (ownerError) {
            Object.assign(item, {
              status: "failed",
              message: `Could not create the organization ${splitLocation(move.to)!.owner}: ${ownerError}`,
            });
            continue;
          }
          item.status = "moving";
          try {
            const result = await executeMove(move, run);
            Object.assign(item, { status: result.status, message: result.message });
            consecutiveErrors = result.unexpected ? consecutiveErrors + 1 : 0;
          } catch (error) {
            Object.assign(item, { status: "failed", message: describe(error) });
            consecutiveErrors++;
          }
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && !state.stoppedBecause) {
            state.stoppedBecause = `Stopped after ${MAX_CONSECUTIVE_ERRORS} destination errors in a row. Check the destination, then check again.`;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, todo.length) }, worker));
    } catch (error) {
      state.stoppedBecause = `The run failed: ${describe(error)}`;
      for (const item of state.items) {
        if (item.status === "waiting" || item.status === "moving") {
          Object.assign(item, { status: "skipped", message: "Not started: the run failed." });
        }
      }
    } finally {
      state.state = "done";
      state.finishedAt = new Date().toISOString();
      const count = (status: PlacementItemStatus) => state.items.filter((item) => item.status === status).length;
      await run
        .logRun({
          message: "Moved mirrors to match the settings",
          details: `Moved ${count("moved")}, recorded ${count("recorded")}, waiting for acceptance ${count("pending")}, failed ${count("failed")}, skipped ${count("skipped")}.${state.stoppedBecause ? ` ${state.stoppedBecause}` : ""}`,
          failed: count("failed") > 0 && count("moved") === 0,
        })
        .catch(() => undefined);
    }
    return state;
  })();

  return { done };
}
