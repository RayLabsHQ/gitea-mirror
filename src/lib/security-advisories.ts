/**
 * Security advisories (#561).
 *
 * Gitea and Forgejo have no advisories of their own, so each published GitHub
 * security advisory of a repository becomes an issue on its mirror, labeled
 * `security-advisory` and titled `[GHSA-xxxx-xxxx-xxxx] summary`. The GHSA id
 * in the title is the marker that finds the issue again on the next sync,
 * where it is updated in place when the advisory changed and closed when the
 * advisory is withdrawn.
 *
 * Only published advisories are listed. A token with admin rights on the
 * source can also see draft and triage advisories, which can describe a
 * vulnerability that is not public yet; those must never reach a mirror.
 */

import type { Octokit } from "@octokit/rest";
import type { Config } from "@/types/config";
import type { Repository } from "./db/schema";
import { httpPatch, httpPost } from "./http-client";
import { listDestinationPages } from "./destination-listing";
import { decryptConfigTokens } from "./utils/config-encryption";
import { isRateLimitError } from "./rate-limit-gate";

export const SECURITY_ADVISORY_LABEL = "security-advisory";
const SECURITY_ADVISORY_LABEL_COLOR = "#d73a4a";
const SECURITY_ADVISORY_LABEL_DESCRIPTION = "Mirrored from a GitHub security advisory";

/** The fields of a GitHub repository security advisory that the mirror reads. */
export interface SourceSecurityAdvisory {
  ghsa_id: string;
  cve_id?: string | null;
  html_url: string;
  summary: string;
  description?: string | null;
  severity?: string | null;
  state?: string | null;
  published_at?: string | null;
  withdrawn_at?: string | null;
  cwe_ids?: string[] | null;
  cvss?: { score?: number | null; vector_string?: string | null } | null;
  vulnerabilities?: Array<{
    package?: { ecosystem?: string | null; name?: string | null } | null;
    vulnerable_version_range?: string | null;
    patched_versions?: string | null;
  }> | null;
  credits_detailed?: Array<{ user?: { login?: string | null } | null; type?: string | null }> | null;
}

interface GiteaIssue {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
}

const GHSA_MARKER = /\[(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})\]/i;

/** A GHSA id in GitHub's own spelling: `GHSA-` then lower case. */
export function normalizeAdvisoryId(id: string): string {
  return `GHSA-${id.slice(5).toLowerCase()}`;
}

/** The GHSA id an issue title carries, normalized, or null. */
export function advisoryIdFromTitle(title: string | null | undefined): string | null {
  const match = title?.match(GHSA_MARKER);
  return match ? normalizeAdvisoryId(match[1]) : null;
}

/**
 * Published advisories of one repository, oldest first. Answers with an empty
 * list when the token may not read them (a GitHub App without the
 * "Repository security advisories" permission, for example), since that is a
 * setup question and not a reason to fail the sync. Rate limits still throw.
 */
export async function listPublishedSecurityAdvisories(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<SourceSecurityAdvisory[]> {
  try {
    const advisories = (await octokit.paginate("GET /repos/{owner}/{repo}/security-advisories", {
      owner,
      repo,
      // Never drafts or triage: they can describe a vulnerability that is not public yet.
      state: "published",
      sort: "published",
      direction: "asc",
      per_page: 100,
    })) as SourceSecurityAdvisory[];
    // Belt and braces for the rule above.
    return advisories.filter((advisory) => advisory.state === "published");
  } catch (error) {
    if (isRateLimitError(error)) throw error;
    const status = (error as { status?: number })?.status;
    if (status === 403 || status === 404) {
      console.warn(
        `[Advisories] Cannot read security advisories of ${owner}/${repo} (HTTP ${status}); skipping. A GitHub App needs the "Repository security advisories" read permission for private repositories.`
      );
      return [];
    }
    throw error;
  }
}

// Backslashes first, so an escaped pipe cannot be undone by one already there.
const cell = (value: string | null | undefined) =>
  (value ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "-";

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

/** The title and body of the issue that mirrors one advisory. */
export function renderSecurityAdvisoryIssue(advisory: SourceSecurityAdvisory): { title: string; body: string } {
  const id = normalizeAdvisoryId(advisory.ghsa_id);
  const title = `[${id}] ${advisory.summary.trim()}`;

  const lines: string[] = [];
  const withdrawn = day(advisory.withdrawn_at);
  if (withdrawn) {
    lines.push(`> **Withdrawn** on ${withdrawn}. This advisory no longer applies.`, "");
  }
  lines.push(`Mirrored from the GitHub security advisory [${id}](${advisory.html_url}).`, "");

  const severity = advisory.severity
    ? advisory.severity.charAt(0).toUpperCase() + advisory.severity.slice(1)
    : "Unknown";
  const score = typeof advisory.cvss?.score === "number" && advisory.cvss.score > 0
    ? ` (CVSS ${advisory.cvss.score.toFixed(1)})`
    : "";
  const facts = [`- **Severity:** ${severity}${score}`];
  if (advisory.cve_id) facts.push(`- **CVE:** ${advisory.cve_id}`);
  if (advisory.cwe_ids?.length) facts.push(`- **Weaknesses:** ${advisory.cwe_ids.join(", ")}`);
  if (advisory.cvss?.vector_string) facts.push(`- **CVSS vector:** \`${advisory.cvss.vector_string}\``);
  const published = day(advisory.published_at);
  if (published) facts.push(`- **Published:** ${published}`);
  // Links rather than @mentions, which would ping same-named destination users.
  const credits = (advisory.credits_detailed ?? [])
    .map((credit) => {
      const login = credit.user?.login;
      if (!login) return null;
      const role = credit.type ? ` (${credit.type.replace(/_/g, " ")})` : "";
      return `[${login}](https://github.com/${login})${role}`;
    })
    .filter((credit): credit is string => credit !== null);
  if (credits.length > 0) facts.push(`- **Credits:** ${credits.join(", ")}`);
  lines.push(...facts);

  const vulnerabilities = advisory.vulnerabilities ?? [];
  if (vulnerabilities.length > 0) {
    lines.push(
      "",
      "### Affected packages",
      "",
      "| Package | Ecosystem | Affected versions | Patched versions |",
      "| --- | --- | --- | --- |",
      ...vulnerabilities.map((vulnerability) =>
        `| ${cell(vulnerability.package?.name)} | ${cell(vulnerability.package?.ecosystem)} | ${cell(vulnerability.vulnerable_version_range)} | ${cell(vulnerability.patched_versions)} |`
      ),
    );
  }

  // The advisory's own text, usually with headings of its own, after a rule.
  const description = advisory.description?.trim();
  if (description) {
    lines.push("", "---", "", description);
  }

  return { title, body: lines.join("\n") };
}

export interface SecurityAdvisoryMirrorResult {
  created: number;
  updated: number;
  closed: number;
}

/**
 * Mirror the published security advisories of one GitHub repository as issues
 * on its destination. One GitHub request per sync (a cheap 304 when nothing
 * changed); the destination is only read when the repository has advisories.
 */
export async function mirrorSecurityAdvisoriesToGitea({
  config,
  octokit,
  repository,
  giteaOwner,
  giteaRepoName,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  giteaOwner: string;
  giteaRepoName: string;
}): Promise<SecurityAdvisoryMirrorResult> {
  const result: SecurityAdvisoryMirrorResult = { created: 0, updated: 0, closed: 0 };
  if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
    throw new Error("Gitea config is required for mirroring security advisories");
  }

  const [owner, repo] = repository.fullName.split("/");
  const advisories = await listPublishedSecurityAdvisories(octokit, owner, repo);
  if (advisories.length === 0) {
    return result;
  }

  const token = decryptConfigTokens(config as Config).giteaConfig.token;
  const base = `${config.giteaConfig.url.replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(giteaOwner)}/${encodeURIComponent(giteaRepoName)}`;
  const auth = { Authorization: `token ${token}` };

  const labelId = await ensureAdvisoryLabel(base, token);

  // Only the labeled issues can be advisories. Without the full list a
  // missing issue would be created a second time, so stop instead.
  const listing = await listDestinationPages<GiteaIssue>({
    url: `${base}/issues`,
    token,
    query: { state: "all", type: "issues", labels: SECURITY_ADVISORY_LABEL },
  });
  if (!listing.complete) {
    throw new Error(`Could not list the existing advisory issues of ${giteaOwner}/${giteaRepoName}`);
  }
  const existingById = new Map<string, GiteaIssue>();
  for (const issue of listing.items) {
    const id = advisoryIdFromTitle(issue.title);
    if (id && !existingById.has(id)) existingById.set(id, issue);
  }

  for (const advisory of advisories) {
    const { title, body } = renderSecurityAdvisoryIssue(advisory);
    const withdrawn = Boolean(advisory.withdrawn_at);
    const existing = existingById.get(normalizeAdvisoryId(advisory.ghsa_id));

    if (!existing) {
      // A withdrawn advisory that was never mirrored has nothing to record.
      if (withdrawn) continue;
      await httpPost(`${base}/issues`, { title, body, labels: [labelId] }, auth);
      result.created++;
      continue;
    }

    const patch: Record<string, unknown> = {};
    if (existing.title !== title) patch.title = title;
    if ((existing.body ?? "") !== body) patch.body = body;
    if (withdrawn && existing.state !== "closed") patch.state = "closed";
    if (Object.keys(patch).length === 0) continue;

    await httpPatch(`${base}/issues/${existing.number}`, patch, auth);
    if (patch.state === "closed") result.closed++;
    else result.updated++;
  }

  console.log(
    `[Advisories] ${repository.fullName}: ${advisories.length} published, ${result.created} created, ${result.updated} updated, ${result.closed} closed as withdrawn`
  );
  return result;
}

/** The id of the `security-advisory` label, created when missing. */
async function ensureAdvisoryLabel(base: string, token: string): Promise<number> {
  const auth = { Authorization: `token ${token}` };
  const labels = await listDestinationPages<{ id: number; name: string }>({ url: `${base}/labels`, token });
  if (!labels.complete) throw new Error("Could not list the destination's labels");
  const found = labels.items.find((label) => label.name === SECURITY_ADVISORY_LABEL);
  if (found) return found.id;

  const created = await httpPost<{ id: number }>(
    `${base}/labels`,
    {
      name: SECURITY_ADVISORY_LABEL,
      color: SECURITY_ADVISORY_LABEL_COLOR,
      description: SECURITY_ADVISORY_LABEL_DESCRIPTION,
    },
    auth,
  );
  return created.data.id;
}

