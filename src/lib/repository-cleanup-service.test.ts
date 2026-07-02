/**
 * Unit tests for the pure orphan-verdict decision logic — regression coverage
 * for issue #331's root cause: `identifyOrphanedRepositories()` treated a DB
 * repository as "orphaned" the moment it was missing from a single bulk
 * GitHub fetch (owned+collaborator+org repos, plus starred repos). That bulk
 * fetch can be transiently incomplete (rate-limit timing, GraphQL star-list
 * pagination quirks, org-allowlist edge cases, etc.), producing false
 * positives that got archived (renamed to `archived-{name}` in Gitea/Forgejo)
 * even though the repo was never actually removed/unstarred on GitHub.
 *
 * The fix adds a second, targeted confirmation call for any repo that merely
 * *looks* orphaned from the bulk list before finalizing it as such.
 * `resolveOrphanVerdict` is the pure decision function extracted from that
 * flow (similar in spirit to classifyAssetsForReconciliation /
 * classifyReleasesForReconciliation in gitea-releases.test.ts) so the
 * decision logic itself is unit-testable without hitting the DB or octokit.
 */

import { describe, test, expect } from "bun:test";
import { resolveOrphanVerdict } from "./repository-cleanup-service";

describe("resolveOrphanVerdict", () => {
  test("repo present in the bulk fetch is never orphaned, regardless of the direct check", () => {
    expect(
      resolveOrphanVerdict({ fullNameFoundInBulkList: true, directCheckConfirmsGone: true })
    ).toBe(false);
    expect(
      resolveOrphanVerdict({ fullNameFoundInBulkList: true, directCheckConfirmsGone: false })
    ).toBe(false);
  });

  test("repo missing from the bulk fetch is orphaned only when the direct check confirms it's gone (404)", () => {
    expect(
      resolveOrphanVerdict({ fullNameFoundInBulkList: false, directCheckConfirmsGone: true })
    ).toBe(true);
  });

  test("repo missing from the bulk fetch but still found by the direct check is NOT orphaned (bulk fetch was incomplete)", () => {
    expect(
      resolveOrphanVerdict({ fullNameFoundInBulkList: false, directCheckConfirmsGone: false })
    ).toBe(false);
  });

  test("repo missing from the bulk fetch whose direct check itself failed (network error, rate limit, etc.) fails safe as NOT orphaned", () => {
    // directCheckConfirmsGone is only true for a clean, explicit 404 — any
    // other outcome (including a failed verification call) is represented
    // as false by the caller, which must resolve to "not orphaned" here.
    expect(
      resolveOrphanVerdict({ fullNameFoundInBulkList: false, directCheckConfirmsGone: false })
    ).toBe(false);
  });
});
