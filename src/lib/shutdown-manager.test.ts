import { describe, expect, test } from "bun:test";
import { shutdownExitCode } from "./shutdown-manager";

describe("shutdownExitCode (#465)", () => {
  test("a crash-driven shutdown exits non-zero so Restart=on-failure restarts the service", () => {
    expect(shutdownExitCode("UNCAUGHT_EXCEPTION")).toBe(1);
    expect(shutdownExitCode("UNHANDLED_REJECTION")).toBe(1);
  });

  test("a signal-driven stop is a clean exit", () => {
    expect(shutdownExitCode("SIGTERM")).toBe(0);
    expect(shutdownExitCode("SIGINT")).toBe(0);
    expect(shutdownExitCode("SIGHUP")).toBe(0);
  });
});
