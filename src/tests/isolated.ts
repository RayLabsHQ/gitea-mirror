import { expect, test } from "bun:test";

const ISOLATED_FILE = "BUN_TEST_ISOLATED_FILE";

/**
 * Bun runs every test file in one process, and a `mock.module()` stays in
 * effect for every file that runs after the one that called it. Which file
 * runs first depends on the machine, so a file whose mocks would change what
 * later files import passes or fails them at random (it broke CI once the
 * runner ordered the files differently).
 *
 * Such a file calls this first. In the shared run it registers one test that
 * runs the file again in a child process and returns false; in that child it
 * returns true. Guard the file's `mock.module()` calls and its describe blocks
 * with the result, so the mocks only ever exist in the child.
 */
export function runsIsolated(path: string): boolean {
  if (process.env[ISOLATED_FILE] === path) return true;

  test(`${path.split("/src/").pop()} runs in its own process`, () => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, "test", path],
      env: { ...process.env, [ISOLATED_FILE]: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (child.exitCode !== 0) {
      console.error(child.stdout.toString());
      console.error(child.stderr.toString());
    }
    expect(child.exitCode).toBe(0);
  }, 60_000);

  return false;
}
