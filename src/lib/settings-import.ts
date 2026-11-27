/**
 * Settings import (#587): reads a file made by settings-export.ts back into
 * an instance, so an export is a backup that can be restored.
 *
 * The rules, in short:
 * - Only what the file holds changes. Settings merge key by key (objects
 *   merge, lists are replaced), sources are added or renamed, and the
 *   organizations and repositories named in the file get exactly the choices
 *   it lists. Anything the file does not mention stays as it is, so
 *   importing the same file twice is safe.
 * - Credentials never come from a file. Saved tokens stay, except a token
 *   tied to an address that the import moves to another host, which is
 *   dropped (a save would refuse instead). New sources that need a token are
 *   added turned off until one is entered.
 * - The same checks as a save: values are validated against the settings
 *   schemas, new addresses go through the outbound guard, and a locked
 *   destination only moves with confirmation.
 * - Organizations and repositories are matched by source and name. Rows the
 *   instance has not imported yet are reported, not created: import the
 *   repositories, then import the file again.
 */
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  cleanupConfigSchema,
  giteaConfigSchema,
  githubConfigSchema,
  notificationConfigSchema,
  scheduleConfigSchema,
} from "@/lib/db/schema";
import {
  SETTINGS_EXPORT_FORMAT,
  SETTINGS_EXPORT_VERSION,
  SETTINGS_SECTIONS,
  STATE_KEYS,
  isCredentialKey,
  sortKeys,
  sourceReference,
  withoutUserInfo,
  type SettingsSection,
} from "@/lib/settings-export";
import {
  SOURCE_PROVIDER_LABELS,
  isSourceProviderKind,
  isValidSourceUrl,
  normalizeSourceUrl,
  type SourceProviderKind,
} from "@/lib/source-providers/kinds";
import {
  normalizeDestinationBaseUrl,
  normalizeDestinationProviderKind,
} from "@/lib/destination-kinds";
import { evaluateConfigChange, loadConfigLocks } from "@/lib/config-locks";
import { blockedOutboundUrlReason } from "@/lib/utils/outbound-url";
import { dropMovedNotificationSecrets, sameOrigin, urlOrigin } from "@/lib/utils/stored-secrets";
import { nextCleanupRun } from "@/lib/utils/cleanup-schedule";
import { normalizeMirrorOverrides, parseMirrorOverrides, listOverriddenKeys } from "@/lib/utils/mirror-overrides";
import { IN_FLIGHT_REPO_STATUSES } from "@/lib/stuck-status-recovery";

/** The import was refused; nothing was changed. */
export class SettingsImportError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = "SettingsImportError";
  }
}

// ---------------------------------------------------------------------------
// The file

const optionalText = z.string().nullish();
const overridesValue = z.record(z.string(), z.unknown()).nullish();

const fileSourceSchema = z.object({
  reference: optionalText,
  name: optionalText,
  provider: z.string(),
  url: optionalText,
  username: optionalText,
  enabled: z.boolean().optional(),
  authentication: z.enum(["none", "token", "password", "github-app"]).optional(),
});

const fileOrganizationSchema = z.object({
  name: z.string().trim().min(1),
  source: optionalText,
  included: z.boolean().optional(),
  ignored: z.boolean().optional(),
  destinationOrg: optionalText,
  mirrorOverrides: overridesValue,
});

const fileRepositorySchema = z.object({
  fullName: z.string().trim().min(1),
  source: optionalText,
  ignored: z.boolean().optional(),
  destinationOrg: optionalText,
  mirrorOverrides: overridesValue,
});

const settingsFileSchema = z.object({
  format: z.string(),
  version: z.number(),
  sources: z.array(fileSourceSchema).max(1_000).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
  organizations: z.array(fileOrganizationSchema).max(100_000).default([]),
  repositories: z.array(fileRepositorySchema).max(500_000).default([]),
});

export type SettingsFile = z.infer<typeof settingsFileSchema>;

/** Reads and checks the file, or throws a SettingsImportError saying why not. */
export function parseSettingsFile(raw: unknown): SettingsFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SettingsImportError("This is not a Gitea Mirror settings file.");
  }
  const head = raw as Record<string, unknown>;
  if (head.format !== SETTINGS_EXPORT_FORMAT) {
    throw new SettingsImportError("This is not a Gitea Mirror settings file.");
  }
  if (typeof head.version !== "number" || head.version > SETTINGS_EXPORT_VERSION) {
    throw new SettingsImportError(
      "This file was made by a newer version of Gitea Mirror. Update this instance, then import it."
    );
  }
  const parsed = settingsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsImportError(
      "The file is damaged or was edited into a shape Gitea Mirror cannot read.",
      parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`)
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// The result

export interface ImportedRowChange {
  name: string;
  source: string | null;
  changes: string[];
}

export interface SettingsImportSummary {
  /** Settings that change, as dotted paths ("giteaConfig.releaseLimit"). */
  settings: string[];
  sources: {
    added: { name: string; reference: string; enabled: boolean }[];
    updated: ImportedRowChange[];
    unchanged: number;
  };
  organizations: { updated: ImportedRowChange[]; unchanged: number; notFound: ImportedRowChange[] };
  repositories: { updated: ImportedRowChange[]; unchanged: number; notFound: ImportedRowChange[] };
  /** What is left to do by hand afterwards: tokens to enter, sources to turn on. */
  todo: string[];
  /** Parts of the file that were not imported, and why. */
  skipped: string[];
  /** Set when the file moves a locked destination and that was not confirmed. */
  destinationLock: string | null;
}

export interface SettingsImportOptions {
  apply: boolean;
  confirmDestinationChange?: boolean;
  /** The outbound address guard; tests replace it to stay off the network. */
  checkUrl?: (url: string) => Promise<string | null>;
  now?: Date;
}

export interface SettingsImportResult {
  applied: boolean;
  summary: SettingsImportSummary;
}

// ---------------------------------------------------------------------------
// Settings

const SECTION_SCHEMAS: Record<SettingsSection, z.ZodType> = {
  githubConfig: githubConfigSchema,
  giteaConfig: giteaConfigSchema,
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  scheduleConfig: scheduleConfigSchema,
  cleanupConfig: cleanupConfigSchema,
  notificationConfig: notificationConfigSchema,
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

/** The fields of an object schema, through optional, nullable and default wrappers. */
function objectShape(schema: z.ZodType | undefined): Record<string, z.ZodType> | null {
  let current: any = schema;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof z.ZodObject) return current.shape as Record<string, z.ZodType>;
    current = current.def?.innerType ?? current.def?.in;
  }
  return null;
}

function parseStored(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Keys that would reach an object's prototype instead of a setting. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const stableJson = (value: unknown) =>
  JSON.stringify(sortKeys(value instanceof Date ? value.toISOString() : value)) ?? "undefined";

/**
 * The file's settings laid over the current ones. Objects merge key by key
 * and anything else replaces, keys the schema does not know and credentials
 * are skipped, and a URL the export cleaned of its user:password part keeps
 * the saved one when that is the only difference.
 */
function mergeSetting(
  current: unknown,
  incoming: unknown,
  schema: z.ZodType | undefined,
  path: string,
  ignored: readonly string[],
  skipped: string[]
): unknown {
  if (isPlainObject(incoming) && (current == null || isPlainObject(current))) {
    const shape = objectShape(schema);
    const out: Record<string, unknown> = { ...((current as Record<string, unknown>) ?? {}) };
    for (const [key, value] of Object.entries(incoming)) {
      const childPath = `${path}.${key}`;
      if (UNSAFE_KEYS.has(key)) {
        skipped.push(`${childPath}: not a setting`);
        continue;
      }
      if (ignored.includes(childPath)) continue;
      if (isCredentialKey(key)) {
        skipped.push(`${childPath}: credentials are never imported, enter them on the Configuration page`);
        continue;
      }
      if (childPath === "notificationConfig.webhook.url") {
        skipped.push(`${childPath}: webhook addresses can hold a secret, enter it on the Notifications tab`);
        continue;
      }
      if (shape && !Object.hasOwn(shape, key)) {
        skipped.push(`${childPath}: not a setting in this version`);
        continue;
      }
      out[key] = mergeSetting(out[key], value, shape?.[key], childPath, ignored, skipped);
    }
    return out;
  }
  if (typeof incoming === "string" && typeof current === "string" && current !== incoming) {
    if (withoutUserInfo(current) === incoming) return current;
  }
  return incoming;
}

/** Dotted paths whose value differs, leaving out credentials and run state. */
function changedPaths(before: unknown, after: unknown, path: string, out: string[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (isCredentialKey(key)) continue;
      changedPaths(before[key], after[key], `${path}.${key}`, out);
    }
    return;
  }
  if (stableJson(before) !== stableJson(after)) out.push(path);
}

interface SettingsPlan {
  changed: string[];
  /** The new value of each section that changes. */
  next: Partial<Record<SettingsSection, unknown>>;
  todo: string[];
  skipped: string[];
  destinationLock: string | null;
}

async function planSettings(
  userId: string,
  config: Record<string, unknown> | null,
  file: SettingsFile,
  options: SettingsImportOptions
): Promise<SettingsPlan> {
  const checkUrl = options.checkUrl ?? blockedOutboundUrlReason;
  const plan: SettingsPlan = { changed: [], next: {}, todo: [], skipped: [], destinationLock: null };
  const known = new Set<string>(SETTINGS_SECTIONS);

  for (const key of Object.keys(file.settings)) {
    if (!known.has(key)) plan.skipped.push(`settings.${key}: not a setting in this version`);
  }

  for (const section of SETTINGS_SECTIONS) {
    const incoming = file.settings[section];
    if (incoming === undefined || incoming === null) continue;
    const before = parseStored(config?.[section]) ?? null;
    const ignored = (STATE_KEYS[section] ?? []).map((key) => `${section}.${key}`);
    let after = mergeSetting(before, incoming, SECTION_SCHEMAS[section], section, ignored, plan.skipped);

    const changed: string[] = [];
    changedPaths(before ?? (isPlainObject(after) ? {} : null), after, section, changed);
    if (changed.length === 0) continue;

    // Validate what the file changes. A key the file leaves alone is not
    // held against it, even when an older save stored it in an older shape.
    const candidate = isPlainObject(after) ? { ...after } : after;
    if (isPlainObject(candidate)) for (const key of STATE_KEYS[section] ?? []) delete candidate[key];
    const result = SECTION_SCHEMAS[section].safeParse(candidate);
    if (!result.success) {
      const touched = new Set(changed.map((path) => path.split(".")[1]));
      const issues = result.error.issues.filter(
        (issue) => !isPlainObject(candidate) || issue.path.length === 0 || touched.has(String(issue.path[0]))
      );
      if (issues.length > 0) {
        throw new SettingsImportError(
          "Some settings in the file have values this version does not accept.",
          issues.slice(0, 10).map((issue) => `${[section, ...issue.path].join(".")}: ${issue.message}`)
        );
      }
    }

    if (section === "giteaConfig" && isPlainObject(after)) {
      after = await checkDestination(userId, before, after, options, checkUrl, plan);
    }
    if (section === "notificationConfig" && isPlainObject(after)) {
      const { config: cleaned, dropped } = dropMovedNotificationSecrets(
        after,
        isPlainObject(before) ? before : null
      );
      after = cleaned;
      for (const label of dropped) {
        plan.todo.push(`Enter the ${label} again on the Notifications tab: its address moved to another host.`);
      }
    }
    if (section === "scheduleConfig" && isPlainObject(after)) {
      // The same rule as a save: a new interval or timezone gets a new next run.
      const old = isPlainObject(before) ? before : {};
      if (old.interval !== after.interval || (old.timezone ?? "UTC") !== (after.timezone ?? "UTC")) {
        const { nextRun: _nextRun, ...rest } = after;
        after = rest;
      }
    }
    if (section === "cleanupConfig" && isPlainObject(after)) {
      const old = isPlainObject(before) ? before : undefined;
      after = {
        ...after,
        nextRun:
          nextCleanupRun({
            enabled: Boolean(after.enabled),
            retentionSeconds: Number(after.retentionDays) || 0,
            previous: old as { enabled?: boolean; retentionDays?: number; nextRun?: unknown } | undefined,
            now: options.now,
          }) ?? null,
      };
    }

    plan.changed.push(...changed);
    plan.next[section] = after;
  }
  return plan;
}

/** The checks a save runs on a new destination address, and its token rule. */
async function checkDestination(
  userId: string,
  before: unknown,
  after: Record<string, unknown>,
  options: SettingsImportOptions,
  checkUrl: (url: string) => Promise<string | null>,
  plan: SettingsPlan
): Promise<Record<string, unknown>> {
  const old = isPlainObject(before) ? before : {};
  const nextUrl = typeof after.url === "string" ? after.url.trim() : "";
  const oldUrl = typeof old.url === "string" ? old.url : "";
  if (nextUrl && nextUrl !== oldUrl) {
    let protocol = "";
    try {
      protocol = new URL(nextUrl).protocol;
    } catch {
      // handled below
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw new SettingsImportError("The destination address in the file must be an http or https URL.");
    }
    const blocked = await checkUrl(nextUrl);
    if (blocked) throw new SettingsImportError(`The destination address in the file was refused: ${blocked}`);

    const verdict = evaluateConfigChange({
      locks: await loadConfigLocks(userId),
      existingSource: null,
      incomingSource: null,
      existingDestinationUrl: oldUrl,
      incomingDestinationUrl: nextUrl,
      confirmDestinationChange: options.confirmDestinationChange === true,
    });
    if (!verdict.ok) plan.destinationLock = verdict.message;
  }

  const oldBase = normalizeDestinationBaseUrl(oldUrl, normalizeDestinationProviderKind(old.provider));
  const nextBase = normalizeDestinationBaseUrl(nextUrl, normalizeDestinationProviderKind(after.provider));
  if (typeof after.token === "string" && after.token && oldBase !== nextBase && !sameOrigin(oldBase, nextBase)) {
    plan.todo.push(
      `Enter a destination token for ${urlOrigin(nextBase) ?? "the new address"} on the Connections tab: ` +
        "the saved one is only sent to the old address."
    );
    return { ...after, token: "" };
  }
  return after;
}

// ---------------------------------------------------------------------------
// Sources

interface SourceRow {
  id: string;
  name: string;
  provider: string;
  url: string;
  username: string;
  enabled: boolean;
  createdAt: Date | number | null;
}

interface PlannedSource {
  key: string;
  reference: string;
  provider: SourceProviderKind;
  url: string;
  username: string;
  name: string;
  enabled: boolean;
}

interface SourcesPlan {
  /** File reference → identity key ("provider\nurl\nusername"). */
  keyByReference: Map<string, string>;
  add: PlannedSource[];
  update: { id: string; name: string; reference: string; changes: string[]; set: { name?: string; enabled?: boolean } }[];
  unchanged: number;
  todo: string[];
  skipped: string[];
}

const identityKey = (provider: string, url: string, username: string) => `${provider}\n${url}\n${username}`;

const AUTH_LABELS = { token: "token", password: "password", "github-app": "GitHub App details" } as const;

async function planSources(
  existing: SourceRow[],
  file: SettingsFile,
  checkUrl: (url: string) => Promise<string | null>
): Promise<SourcesPlan> {
  const plan: SourcesPlan = { keyByReference: new Map(), add: [], update: [], unchanged: 0, todo: [], skipped: [] };
  const byKey = new Map(existing.map((row) => [identityKey(row.provider, row.url, row.username), row]));
  const seen = new Set<string>();

  for (const entry of file.sources) {
    const label = entry.name?.trim() || entry.reference?.trim() || entry.provider;
    if (!isSourceProviderKind(entry.provider)) {
      throw new SettingsImportError(`The source "${label}" has a provider this version does not know: ${entry.provider}.`);
    }
    const provider = entry.provider;
    const rawUrl = entry.url?.trim() ?? "";
    if (provider === "git" && !rawUrl) {
      throw new SettingsImportError(`The Git URL source "${label}" has no host URL.`);
    }
    if (rawUrl && !isValidSourceUrl(rawUrl)) {
      throw new SettingsImportError(`The source "${label}" needs an http or https URL.`);
    }
    const url = normalizeSourceUrl(rawUrl, provider);
    const username = entry.username?.trim() ?? "";
    const key = identityKey(provider, url, username);
    const reference = sourceReference({ provider, url, username });
    plan.keyByReference.set(reference, key);
    if (entry.reference?.trim()) plan.keyByReference.set(entry.reference.trim(), key);
    if (seen.has(key)) continue;
    seen.add(key);

    const name = entry.name?.trim() || "";
    const row = byKey.get(key);
    if (row) {
      const set: { name?: string; enabled?: boolean } = {};
      const changes: string[] = [];
      if (name && name !== row.name) {
        set.name = name;
        changes.push(`renamed from ${row.name}`);
      }
      if (typeof entry.enabled === "boolean" && entry.enabled !== row.enabled) {
        set.enabled = entry.enabled;
        changes.push(entry.enabled ? "turned on" : "turned off");
      }
      if (changes.length > 0) plan.update.push({ id: row.id, name: name || row.name, reference, changes, set });
      else plan.unchanged++;
      continue;
    }

    if (rawUrl) {
      const blocked = await checkUrl(url);
      if (blocked) throw new SettingsImportError(`The address of the source "${label}" was refused: ${blocked}`);
    }
    const wanted = entry.enabled !== false;
    const auth = entry.authentication && entry.authentication !== "none" ? entry.authentication : null;
    const displayName = name || SOURCE_PROVIDER_LABELS[provider];
    // A source that logs in stays off until it has its credential again:
    // turned on without one, it would list only public repositories.
    plan.add.push({ key, reference, provider, url, username, name, enabled: wanted && !auth });
    if (auth) {
      plan.todo.push(
        `Enter the ${AUTH_LABELS[auth]} for the source ${displayName} on the Connections tab` +
          (wanted ? ", then turn it on." : ".")
      );
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Organizations and repositories

interface ChoiceRow {
  id: string;
  name: string;
  normalized: string;
  sourceId: string | null;
  status: string;
  isIncluded?: boolean;
  destinationOrg: string | null;
  mirrorOverrides: unknown;
  lastMirrored?: Date | number | null;
}

interface ChoiceEntry {
  name: string;
  source: string | null;
  included?: boolean;
  ignored?: boolean;
  destinationOrg?: string | null;
  mirrorOverrides?: Record<string, unknown> | null;
}

interface ChoicesPlan {
  updates: { id: string; set: Record<string, unknown> }[];
  summary: { updated: ImportedRowChange[]; unchanged: number; notFound: ImportedRowChange[] };
  skipped: string[];
}

const ORG_IN_FLIGHT = new Set(["mirroring", "deleting"]);
const REPO_IN_FLIGHT = new Set<string>([...IN_FLIGHT_REPO_STATUSES, "deleting"]);

/** Overrides as a comparable value: null when nothing is pinned. */
function overridesValueOf(value: unknown): Record<string, unknown> | null {
  const normalized = normalizeMirrorOverrides(parseStored(value));
  return normalized && listOverriddenKeys(normalized).length > 0 ? (normalized as Record<string, unknown>) : null;
}

function planChoices(
  kind: "organization" | "repository",
  rows: ChoiceRow[],
  entries: ChoiceEntry[],
  sourceIdOf: (reference: string | null) => string | null | undefined,
  knownSourceIds: Set<string>
): ChoicesPlan {
  const plan: ChoicesPlan = { updates: [], summary: { updated: [], unchanged: 0, notFound: [] }, skipped: [] };
  const index = new Map<string, ChoiceRow[]>();
  const byName = new Map<string, ChoiceRow[]>();
  for (const row of rows) {
    // Rows whose source is gone count as having none.
    const sourceKey = row.sourceId && knownSourceIds.has(row.sourceId) ? row.sourceId : "";
    const key = `${sourceKey}\n${row.normalized}`;
    index.set(key, [...(index.get(key) ?? []), row]);
    byName.set(row.normalized, [...(byName.get(row.normalized) ?? []), row]);
  }
  const inFlight = kind === "organization" ? ORG_IN_FLIGHT : REPO_IN_FLIGHT;

  for (const entry of entries) {
    const normalized = entry.name.trim().toLowerCase();
    const sourceId = sourceIdOf(entry.source);
    let matches = sourceId === undefined ? [] : index.get(`${sourceId ?? ""}\n${normalized}`) ?? [];
    // An organization can be pinned to a source on one instance and not on
    // the other, so a name only one row has still matches when one side has
    // no source. Never across two sources: GitLab's "acme" is not GitHub's.
    const single = byName.get(normalized);
    if (matches.length === 0 && sourceId !== undefined && single?.length === 1) {
      const rowSource = single[0].sourceId && knownSourceIds.has(single[0].sourceId) ? single[0].sourceId : null;
      if (sourceId === null || rowSource === null) matches = single;
    }
    if (matches.length === 0) {
      plan.summary.notFound.push({ name: entry.name, source: entry.source, changes: [] });
      continue;
    }

    let wantOverrides: Record<string, unknown> | null | undefined;
    if (entry.mirrorOverrides && Object.keys(entry.mirrorOverrides).length > 0) {
      if (parseMirrorOverrides(entry.mirrorOverrides) === null) {
        plan.skipped.push(`${entry.name}: its mirror options are not valid in this version and were left as they are`);
        wantOverrides = undefined;
      } else {
        wantOverrides = overridesValueOf(entry.mirrorOverrides);
      }
    } else {
      wantOverrides = null;
    }

    for (const row of matches) {
      const set: Record<string, unknown> = {};
      const changes: string[] = [];

      if (kind === "organization") {
        const included = entry.included !== false;
        if ((row.isIncluded !== false) !== included) {
          set.isIncluded = included;
          changes.push(included ? "included" : "left out");
        }
      }

      const ignored = entry.ignored === true;
      if ((row.status === "ignored") !== ignored) {
        if (inFlight.has(row.status)) {
          plan.skipped.push(`${entry.name}: busy (${row.status}), so its ignore choice was not changed; import again later`);
        } else {
          set.status = ignored
            ? "ignored"
            : kind === "repository" && row.lastMirrored
              ? "mirrored"
              : "imported";
          changes.push(ignored ? "ignored" : "no longer ignored");
        }
      }

      const destination = entry.destinationOrg?.trim() || null;
      if ((row.destinationOrg?.trim() || null) !== destination) {
        set.destinationOrg = destination;
        changes.push(destination ? `destination ${destination}` : "default destination");
      }

      if (wantOverrides !== undefined && stableJson(overridesValueOf(row.mirrorOverrides)) !== stableJson(wantOverrides)) {
        set.mirrorOverrides = wantOverrides;
        changes.push(wantOverrides ? "mirror options" : "mirror options cleared");
      }

      if (changes.length > 0) {
        plan.updates.push({ id: row.id, set });
        plan.summary.updated.push({ name: row.name, source: entry.source, changes });
      } else {
        plan.summary.unchanged++;
      }
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Putting it together

async function loadConfigRow(userId: string): Promise<Record<string, unknown> | null> {
  const { db, configs } = await import("@/lib/db");
  const [row] = await db
    .select()
    .from(configs)
    .where(eq(configs.userId, userId))
    .orderBy(sql`${configs.isActive} desc`, sql`${configs.updatedAt} desc`)
    .limit(1);
  return (row as Record<string, unknown> | undefined) ?? null;
}

async function loadChoiceRows(userId: string): Promise<{ organizations: ChoiceRow[]; repositories: ChoiceRow[] }> {
  const { db, organizations, repositories } = await import("@/lib/db");
  const orgRows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      normalized: organizations.normalizedName,
      sourceId: organizations.sourceId,
      status: organizations.status,
      isIncluded: organizations.isIncluded,
      destinationOrg: organizations.destinationOrg,
      mirrorOverrides: organizations.mirrorOverrides,
    })
    .from(organizations)
    .where(eq(organizations.userId, userId));
  const repoRows = await db
    .select({
      id: repositories.id,
      name: repositories.fullName,
      normalized: repositories.normalizedFullName,
      sourceId: repositories.sourceId,
      status: repositories.status,
      destinationOrg: repositories.destinationOrg,
      mirrorOverrides: repositories.mirrorOverrides,
      lastMirrored: repositories.lastMirrored,
    })
    .from(repositories)
    .where(eq(repositories.userId, userId));
  const lower = (rows: ChoiceRow[]) => rows.map((row) => ({ ...row, normalized: (row.normalized || row.name).toLowerCase() }));
  return { organizations: lower(orgRows as ChoiceRow[]), repositories: lower(repoRows as ChoiceRow[]) };
}

async function loadSourceRows(userId: string): Promise<SourceRow[]> {
  const { listSources } = await import("@/lib/sources");
  return (await listSources(userId)) as unknown as SourceRow[];
}

function planAllChoices(file: SettingsFile, sources: SourcesPlan, rows: SourceRow[], choiceRows: Awaited<ReturnType<typeof loadChoiceRows>>) {
  const idByKey = new Map(rows.map((row) => [identityKey(row.provider, row.url, row.username), row.id]));
  const known = new Set(rows.map((row) => row.id));
  // undefined: the file names a source this instance does not have (yet).
  const sourceIdOf = (reference: string | null): string | null | undefined => {
    if (!reference) return null;
    const key = sources.keyByReference.get(reference.trim());
    return key ? idByKey.get(key) : undefined;
  };
  const organizations = planChoices(
    "organization",
    choiceRows.organizations,
    file.organizations.map((org) => ({ ...org, source: org.source ?? null })),
    sourceIdOf,
    known
  );
  const repositories = planChoices(
    "repository",
    choiceRows.repositories,
    file.repositories.map(({ fullName, ...repo }) => ({ ...repo, name: fullName, source: repo.source ?? null })),
    sourceIdOf,
    known
  );
  return { organizations, repositories };
}

function notFoundTodo(summary: SettingsImportSummary): string | null {
  const orgs = summary.organizations.notFound.length;
  const repos = summary.repositories.notFound.length;
  if (orgs + repos === 0) return null;
  const parts = [
    orgs ? `${orgs} ${orgs === 1 ? "organization" : "organizations"}` : "",
    repos ? `${repos} ${repos === 1 ? "repository" : "repositories"}` : "",
  ].filter(Boolean);
  return (
    `${parts.join(" and ")} in the file ${orgs + repos === 1 ? "is" : "are"} not on this instance yet. ` +
    "Import the repositories from your sources, then import this file again to apply their choices."
  );
}

/**
 * Reads a settings file into the user's instance. With `apply: false` it only
 * works out what would change; with `apply: true` it makes the changes,
 * unless the file moves a locked destination without confirmation, in which
 * case nothing changes and the summary carries the lock message.
 */
export async function importSettings(
  userId: string,
  raw: unknown,
  options: SettingsImportOptions
): Promise<SettingsImportResult> {
  const file = parseSettingsFile(raw);
  const checkUrl = options.checkUrl ?? blockedOutboundUrlReason;

  let config = await loadConfigRow(userId);
  let settingsPlan = await planSettings(userId, config, file, options);
  const existingSources = await loadSourceRows(userId);
  const sourcesPlan = await planSources(existingSources, file, checkUrl);
  let choices = planAllChoices(file, sourcesPlan, existingSources, await loadChoiceRows(userId));

  const summarize = (): SettingsImportSummary => {
    const summary: SettingsImportSummary = {
      settings: settingsPlan.changed,
      sources: {
        added: sourcesPlan.add.map((s) => ({
          name: s.name || SOURCE_PROVIDER_LABELS[s.provider],
          reference: s.reference,
          enabled: s.enabled,
        })),
        updated: sourcesPlan.update.map((s) => ({ name: s.name, source: s.reference, changes: s.changes })),
        unchanged: sourcesPlan.unchanged,
      },
      organizations: choices.organizations.summary,
      repositories: choices.repositories.summary,
      todo: [...settingsPlan.todo, ...sourcesPlan.todo],
      skipped: [...settingsPlan.skipped, ...sourcesPlan.skipped, ...choices.organizations.skipped, ...choices.repositories.skipped],
      destinationLock: settingsPlan.destinationLock,
    };
    const waiting = notFoundTodo(summary);
    if (waiting) summary.todo.push(waiting);
    return summary;
  };

  if (!options.apply || settingsPlan.destinationLock) {
    return { applied: false, summary: summarize() };
  }

  const { db, configs, sources, organizations, repositories } = await import("@/lib/db");
  const { createSource, updateSource, syncPrimarySourceToConfig } = await import("@/lib/sources");

  // 1. Settings. A user who never opened the Configuration page has no row
  // yet; it starts from the same defaults the page would create, and the
  // file is laid over those.
  if (!config) {
    const { createDefaultConfig } = await import("@/lib/utils/config-defaults");
    await createDefaultConfig({ userId });
    config = await loadConfigRow(userId);
    settingsPlan = await planSettings(userId, config, file, options);
  }
  if (Object.keys(settingsPlan.next).length > 0) {
    if (config) {
      await db
        .update(configs)
        .set({ ...(settingsPlan.next as Record<string, unknown>), updatedAt: new Date() })
        .where(and(eq(configs.id, config.id as string), eq(configs.userId, userId)));
    }
  }

  // 2. Sources, after the settings: adding one writes the first source back
  // into the settings row. New sources keep the file's order, so the first
  // one in the file is the first one here too.
  for (const update of sourcesPlan.update) {
    await updateSource(userId, update.id, update.set);
  }
  if (sourcesPlan.add.length > 0) {
    const latest = Math.max(
      0,
      ...existingSources.map((row) => Math.floor(+new Date(row.createdAt ?? 0) / 1000))
    );
    let next = Math.max(Math.floor(Date.now() / 1000), latest + 1);
    for (const source of sourcesPlan.add) {
      const created = await createSource(userId, {
        provider: source.provider,
        url: source.url,
        username: source.username,
        name: source.name || null,
        enabled: source.enabled,
      });
      await db
        .update(sources)
        .set({ createdAt: new Date(next++ * 1000) })
        .where(and(eq(sources.id, created.id), eq(sources.userId, userId)));
    }
    await syncPrimarySourceToConfig(userId);
  }

  // 3. Choices, worked out again now that the new sources exist.
  if (sourcesPlan.add.length > 0) {
    choices = planAllChoices(file, sourcesPlan, await loadSourceRows(userId), await loadChoiceRows(userId));
  }
  const now = new Date();
  for (const { id, set } of choices.organizations.updates) {
    await db
      .update(organizations)
      .set({ ...set, updatedAt: now })
      .where(and(eq(organizations.id, id), eq(organizations.userId, userId)));
  }
  for (const { id, set } of choices.repositories.updates) {
    await db
      .update(repositories)
      .set({ ...set, updatedAt: now })
      .where(and(eq(repositories.id, id), eq(repositories.userId, userId)));
  }

  return { applied: true, summary: summarize() };
}
