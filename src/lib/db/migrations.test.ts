import { expect, test } from "bun:test";

function decodeOutput(output: ArrayBufferLike | Uint8Array | null | undefined) {
  if (!output) {
    return "";
  }

  return Buffer.from(output as ArrayBufferLike).toString("utf8");
}

test("migration validation script passes", () => {
  const result = Bun.spawnSync({
    cmd: ["bun", "scripts/validate-migrations.ts"],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = decodeOutput(result.stdout);
  const stderr = decodeOutput(result.stderr);

  expect(
    result.exitCode,
    `Migration validation script failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  ).toBe(0);
});
