/**
 * The run that moves mirrors (#550): the order of steps, what is recorded
 * after each, and what a failure halfway leaves behind. The destination is
 * an in-memory model; HttpError stands in for its refusals.
 */
import { describe, expect, test } from "bun:test";
import { runsIsolated } from "@/tests/isolated";
import type { PlannedMove, PlacementPreview } from "./mirror-placement";

// Other files mock modules this one imports; run it on its own.
const isChild = runsIsolated(import.meta.path);
const { executeMove, startPlacementRun, PlacementRunBusyError } = (
  isChild ? await import("./mirror-placement-run") : {}
) as typeof import("./mirror-placement-run");
const { HttpError } = (isChild ? await import("./http-client") : {}) as typeof import("./http-client");

type Deps = import("./mirror-placement-run").PlacementRunDeps;

function fakeDestination(preview?: Partial<PlacementPreview>) {
  const repos = new Set<string>();
  const calls: string[] = [];
  const records: Array<[string, string]> = [];
  const failures: Record<string, () => Error> = {};
  const statuses: Record<string, string> = {};
  let pending = false;
  const fail = (key: string) => {
    const make = failures[key];
    if (make) throw make();
  };
  const deps: Deps = {
    ensureOwner: async (owner) => {
      calls.push(`create ${owner}`);
      fail(`create ${owner}`);
    },
    transfer: async (owner, name, newOwner) => {
      calls.push(`transfer ${owner}/${name} -> ${newOwner}`);
      fail(`transfer ${owner}/${name}`);
      if (pending) return { pending: true, repo: null } as any;
      repos.delete(`${owner}/${name}`);
      repos.add(`${newOwner}/${name}`);
      return { pending: false, repo: { name, owner: { login: newOwner } } } as any;
    },
    rename: async (owner, name, newName) => {
      calls.push(`rename ${owner}/${name} -> ${newName}`);
      fail(`rename ${owner}/${name}`);
      repos.delete(`${owner}/${name}`);
      repos.add(`${owner}/${newName}`);
    },
    record: async (id, location) => {
      records.push([id, location]);
    },
    rowStatus: async (id) => statuses[id] ?? "mirrored",
    log: async () => {},
    logRun: async () => {},
    replan: async (rename) => ({ rename, moves: [], blocked: [], skipped: [], inPlace: 0, ...preview }),
  };
  return {
    deps,
    calls,
    records,
    failures,
    statuses,
    setPending: (value: boolean) => (pending = value),
  };
}

function move(overrides: Partial<PlannedMove> = {}): PlannedMove {
  return {
    id: "r1",
    fullName: "jeff/bar",
    from: "Mirrors/bar-jeff",
    to: "jeff/bar",
    via: "strategy",
    kind: "move",
    ownerState: "organization",
    renamed: true,
    order: "transfer-first",
    ...overrides,
  };
}

describe.skipIf(!isChild)("executeMove", () => {
  test("transfers, then renames, recording the location after each step", async () => {
    const d = fakeDestination();
    const result = await executeMove(move(), d.deps);
    expect(d.calls).toEqual(["transfer Mirrors/bar-jeff -> jeff", "rename jeff/bar-jeff -> bar"]);
    expect(d.records).toEqual([["r1", "jeff/bar-jeff"], ["r1", "jeff/bar"]]);
    expect(result).toMatchObject({ status: "moved", message: "Now at jeff/bar." });
  });

  test("renames first when the plan says so", async () => {
    const d = fakeDestination();
    await executeMove(move({ order: "rename-first" }), d.deps);
    expect(d.calls).toEqual(["rename Mirrors/bar-jeff -> bar", "transfer Mirrors/bar -> jeff"]);
    expect(d.records).toEqual([["r1", "Mirrors/bar"], ["r1", "jeff/bar"]]);
  });

  test("a record-only change touches nothing on the destination", async () => {
    const d = fakeDestination();
    const result = await executeMove(move({ kind: "record", from: "Mirrors/site", to: "acme/site" }), d.deps);
    expect(d.calls).toEqual([]);
    expect(d.records).toEqual([["r1", "acme/site"]]);
    expect(result.status).toBe("recorded");
  });

  test("a name taken since the preview fails the move and changes nothing", async () => {
    const d = fakeDestination();
    d.failures["transfer Mirrors/bar-jeff"] = () => new HttpError("HTTP 422", 422, "Unprocessable Entity");
    const result = await executeMove(move(), d.deps);
    expect(result).toMatchObject({
      status: "failed",
      message: "jeff/bar-jeff was taken since you checked. Nothing was changed.",
      unexpected: false,
    });
    expect(d.records).toEqual([]);
  });

  test("a failed transfer after the rename says where the mirror is now", async () => {
    const d = fakeDestination();
    d.failures["transfer Mirrors/bar"] = () => new HttpError("HTTP 500", 500, "Internal Server Error");
    const result = await executeMove(move({ order: "rename-first" }), d.deps);
    expect(result).toMatchObject({
      status: "failed",
      message: "The destination answered 500 to the transfer. It was renamed to Mirrors/bar and stays there.",
      unexpected: true,
    });
    expect(d.records).toEqual([["r1", "Mirrors/bar"]]);
  });

  test("a failed rename after the transfer still counts as moved", async () => {
    const d = fakeDestination();
    d.failures["rename jeff/bar-jeff"] = () => new HttpError("HTTP 422", 422, "Unprocessable Entity");
    const result = await executeMove(move(), d.deps);
    expect(result.status).toBe("moved");
    expect(result.message).toBe("Moved to jeff/bar-jeff, but not renamed: jeff/bar was taken since you checked.");
    expect(d.records).toEqual([["r1", "jeff/bar-jeff"]]);
  });

  test("a transfer waiting for acceptance leaves the record alone", async () => {
    const d = fakeDestination();
    d.setPending(true);
    const result = await executeMove(move(), d.deps);
    expect(result.status).toBe("pending");
    expect(result.message).toContain("Waiting for an owner of jeff to accept");
    expect(d.records).toEqual([]);
  });

  test("a mirror that started syncing is not moved", async () => {
    const d = fakeDestination();
    d.statuses.r1 = "syncing";
    const result = await executeMove(move(), d.deps);
    expect(result.status).toBe("skipped");
    expect(d.calls).toEqual([]);
  });
});

describe.skipIf(!isChild)("startPlacementRun", () => {
  const config = { giteaConfig: { url: "http://gitea", token: "t", defaultOwner: "me" } } as any;

  test("moves only what the user saw, and says why the rest did not move", async () => {
    const d = fakeDestination({
      moves: [
        move({ id: "a", fullName: "x/a", from: "Mirrors/a", to: "x/a", renamed: false }),
        move({ id: "b", fullName: "x/b", from: "Mirrors/b", to: "y/b", renamed: false }),
      ],
      blocked: [{ id: "c", fullName: "x/c", from: "Mirrors/c", to: "x/c", via: "strategy", reason: "x/c is taken by another repository.", hint: "Rename it." }],
    });
    const { done } = await startPlacementRun({
      userId: "u1",
      config,
      rename: true,
      moves: [{ id: "a", to: "x/a" }, { id: "b", to: "x/b" }, { id: "c", to: "x/c" }],
      deps: d.deps,
    });
    const state = await done;
    const byId = Object.fromEntries(state.items.map((item) => [item.id, item]));
    expect(byId.a.status).toBe("moved");
    expect(byId.b).toMatchObject({ status: "skipped", message: "Its target changed to y/b since you checked. Check again." });
    expect(byId.c).toMatchObject({ status: "skipped", message: "Changed since you checked: x/c is taken by another repository. Rename it." });
    expect(d.calls).toEqual(["transfer Mirrors/a -> x"]);
    expect(state.state).toBe("done");
  });

  test("creates each new organization once, and fails only its moves when it cannot", async () => {
    const d = fakeDestination({
      moves: [
        move({ id: "a", fullName: "x/a", from: "M/a", to: "neworg/a", renamed: false, ownerState: "new-organization" }),
        move({ id: "b", fullName: "x/b", from: "M/b", to: "neworg/b", renamed: false, ownerState: "new-organization" }),
        move({ id: "c", fullName: "x/c", from: "M/c", to: "bad/c", renamed: false, ownerState: "new-organization" }),
      ],
    });
    d.failures["create bad"] = () => new Error("name is reserved");
    const { done } = await startPlacementRun({
      userId: "u2",
      config,
      rename: false,
      moves: [{ id: "a", to: "neworg/a" }, { id: "b", to: "neworg/b" }, { id: "c", to: "bad/c" }],
      deps: d.deps,
    });
    const state = await done;
    expect(d.calls.filter((call) => call.startsWith("create"))).toEqual(["create neworg", "create bad"]);
    expect(state.items.map((item) => item.status)).toEqual(["moved", "moved", "failed"]);
    expect(state.items[2].message).toBe("Could not create the organization bad: name is reserved");
  });

  test("stops after three destination errors in a row", async () => {
    const moves = ["a", "b", "c", "d", "e"].map((id) =>
      move({ id, fullName: `x/${id}`, from: `M/${id}`, to: `x/${id}`, renamed: false })
    );
    const d = fakeDestination({ moves });
    for (const id of ["a", "b", "c", "d", "e"]) {
      d.failures[`transfer M/${id}`] = () => new HttpError("HTTP 502", 502, "Bad Gateway");
    }
    const { done } = await startPlacementRun({
      userId: "u3",
      config,
      rename: false,
      moves: moves.map((m) => ({ id: m.id, to: m.to })),
      deps: d.deps,
    });
    const state = await done;
    expect(state.stoppedBecause).toContain("Stopped after 3 destination errors in a row");
    expect(state.items.filter((item) => item.status === "skipped").length).toBeGreaterThan(0);
    expect(d.calls.length).toBeLessThan(5);
  });

  test("one run per user at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const d = fakeDestination({ moves: [move({ id: "a", to: "x/a", from: "M/a", renamed: false })] });
    const replan = d.deps.replan;
    d.deps.replan = async (rename) => {
      await gate;
      return replan(rename);
    };
    const first = await startPlacementRun({ userId: "u4", config, rename: false, moves: [{ id: "a", to: "x/a" }], deps: d.deps });
    await expect(
      startPlacementRun({ userId: "u4", config, rename: false, moves: [{ id: "a", to: "x/a" }], deps: d.deps })
    ).rejects.toBeInstanceOf(PlacementRunBusyError);
    release();
    await first.done;
    // Once finished, another can start.
    const again = await startPlacementRun({ userId: "u4", config, rename: false, moves: [{ id: "a", to: "x/a" }], deps: d.deps });
    await again.done;
  });
});
