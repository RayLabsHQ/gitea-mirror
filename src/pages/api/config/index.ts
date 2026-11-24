import type { APIRoute } from "astro";
import {
  SOURCE_PROVIDER_LABELS,
  isSourceProviderKind,
  isValidSourceUrl,
  normalizeSourceProviderKind,
  normalizeSourceUrl,
} from "@/lib/source-providers/kinds";
import { evaluateConfigChange, loadConfigLocks } from "@/lib/config-locks";
import {
  DESTINATION_PROVIDER_DEFAULT_URLS,
  DESTINATION_PROVIDER_LABELS,
  isDestinationProviderKind,
  isPushDestinationKind,
  normalizeDestinationBaseUrl,
  normalizeDestinationProviderKind,
} from "@/lib/destination-kinds";
import { db, configs, users } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import { eq, sql } from "drizzle-orm";
import { createSecureErrorResponse } from "@/lib/utils";
import { 
  mapUiToDbConfig, 
  mapDbToUiConfig, 
  mapUiScheduleToDb, 
  mapUiCleanupToDb,
  mapDbScheduleToUi,
  mapDbCleanupToUi 
} from "@/lib/utils/config-mapper";
import {
  SecretHostChangedError,
  hasValue,
  mergeNotificationSecrets,
  nextStoredSecret,
  redactNotificationSecrets,
  takeRemovedNotificationSecrets,
} from "@/lib/utils/stored-secrets";
import { createDefaultConfig } from "@/lib/utils/config-defaults";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { blockedOutboundUrlReason } from "@/lib/utils/outbound-url";
import { notificationConfigSchema } from "@/lib/db/schema";
import {
  loadSourceApiItems,
  type SourceApiItem,
} from "@/lib/sources-api";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body = await request.json();
    const {
      githubConfig,
      giteaConfig,
      scheduleConfig,
      cleanupConfig,
      mirrorOptions,
      advancedOptions,
      notificationConfig,
      confirmSourceChange,
      confirmDestinationChange,
    } = body;

    if (!githubConfig || !giteaConfig || !scheduleConfig || !cleanupConfig || !mirrorOptions || !advancedOptions) {
      return new Response(
        JSON.stringify({
          success: false,
          message:
            "githubConfig, giteaConfig, scheduleConfig, cleanupConfig, mirrorOptions, and advancedOptions are required.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // A secret sent as null is removed; take those out before validating.
    const { config: rawNotificationConfig, removed: removedNotificationSecrets } =
      takeRemovedNotificationSecrets(notificationConfig);
    let validatedNotificationConfig: any = undefined;
    if (notificationConfig !== undefined) {
      const parsed = notificationConfigSchema.safeParse(rawNotificationConfig);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({
            success: false,
            message: `Invalid notificationConfig: ${parsed.error.message}`,
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      validatedNotificationConfig = parsed.data;
    }

    // Validate Gitea URL format and protocol
    if (giteaConfig.url) {
      try {
        const giteaUrl = new URL(giteaConfig.url);
        if (!['http:', 'https:'].includes(giteaUrl.protocol)) {
          return new Response(
            JSON.stringify({ success: false, message: "Gitea URL must use http or https protocol." }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: "Invalid Gitea URL format." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      const blockedDestination = await blockedOutboundUrlReason(giteaConfig.url);
      if (blockedDestination) {
        return new Response(
          JSON.stringify({ success: false, message: blockedDestination }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Validate the destination provider. GitHub and GitLab targets default to
    // their public instance when no URL is given.
    if (giteaConfig.provider !== undefined && !isDestinationProviderKind(giteaConfig.provider)) {
      return new Response(
        JSON.stringify({ success: false, message: "Unknown destination provider." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const destinationProvider = normalizeDestinationProviderKind(giteaConfig.provider);
    if (
      isPushDestinationKind(destinationProvider) &&
      !(typeof giteaConfig.url === "string" && giteaConfig.url.trim())
    ) {
      giteaConfig.url = DESTINATION_PROVIDER_DEFAULT_URLS[destinationProvider];
    }

    // Validate the source provider and, for GitLab and Gitea sources, the instance URL
    if (githubConfig.provider !== undefined && !isSourceProviderKind(githubConfig.provider)) {
      return new Response(
        JSON.stringify({ success: false, message: "Unknown source provider." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const sourceProvider = normalizeSourceProviderKind(githubConfig.provider);
    if (sourceProvider !== "github") {
      const rawSourceUrl = typeof githubConfig.url === "string" ? githubConfig.url.trim() : "";
      if (rawSourceUrl && !isValidSourceUrl(rawSourceUrl)) {
        return new Response(
          JSON.stringify({
            success: false,
            message: `${SOURCE_PROVIDER_LABELS[sourceProvider]} URL must be a valid http or https URL.`,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      const blockedSource = rawSourceUrl ? await blockedOutboundUrlReason(rawSourceUrl) : null;
      if (blockedSource) {
        return new Response(
          JSON.stringify({ success: false, message: blockedSource }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Fetch existing config — prefer the active config; fall back to most-recently-updated
    // so a stale inactive stub never wins over a populated active row (see issue #271).
    const existingConfigResult = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    const existingConfig = existingConfigResult[0];

    // Parse the stored configs once — used both to preserve fields the
    // Configuration form doesn't expose (e.g. env-configured mirrorInterval,
    // see issue #338) and to preserve tokens when the form submits them empty.
    let existingGithub: Record<string, any> | undefined;
    let existingGitea: Record<string, any> | undefined;
    if (existingConfig) {
      try {
        existingGithub =
          typeof existingConfig.githubConfig === "string"
            ? JSON.parse(existingConfig.githubConfig)
            : existingConfig.githubConfig;

        existingGitea =
          typeof existingConfig.giteaConfig === "string"
            ? JSON.parse(existingConfig.giteaConfig)
            : existingConfig.giteaConfig;
      } catch (parseError) {
        console.error("Failed to parse existing config:", parseError);
      }
    }

    // A locked source or destination only changes with explicit confirmation.
    if (existingConfig) {
      const locks = await loadConfigLocks(userId);
      const verdict = evaluateConfigChange({
        locks,
        existingSource: existingGithub,
        incomingSource: githubConfig,
        existingDestinationUrl: existingGitea?.url,
        incomingDestinationUrl: giteaConfig.url,
        confirmSourceChange: confirmSourceChange === true,
        confirmDestinationChange: confirmDestinationChange === true,
      });
      if (!verdict.ok) {
        return new Response(
          JSON.stringify({ success: false, message: verdict.message, lock: verdict.lock }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Map UI structure to database schema structure first
    const { githubConfig: mappedGithubConfig, giteaConfig: mappedGiteaConfig } = mapUiToDbConfig(
      githubConfig,
      giteaConfig,
      mirrorOptions,
      advancedOptions,
      { githubConfig: existingGithub, giteaConfig: existingGitea }
    );

    // Tokens are write-only: GET never returns them, so an empty field keeps
    // the saved token. A saved token only stays while the address keeps the
    // same scheme, host and port (see stored-secrets).
    let processedNotificationConfig: any = undefined;
    try {
      mappedGithubConfig.token = nextStoredSecret({
        label: `${SOURCE_PROVIDER_LABELS[sourceProvider]} token`,
        incoming: mappedGithubConfig.token,
        stored: existingGithub?.token,
        bound: true,
        storedUrl: normalizeSourceUrl(
          existingGithub?.url,
          normalizeSourceProviderKind(existingGithub?.provider)
        ),
        nextUrl: normalizeSourceUrl(mappedGithubConfig.url, sourceProvider),
      });
      mappedGiteaConfig.token = nextStoredSecret({
        label: `${DESTINATION_PROVIDER_LABELS[destinationProvider]} token`,
        incoming: mappedGiteaConfig.token,
        stored: existingGitea?.token,
        bound: true,
        storedUrl: normalizeDestinationBaseUrl(
          existingGitea?.url,
          normalizeDestinationProviderKind(existingGitea?.provider)
        ),
        nextUrl: normalizeDestinationBaseUrl(mappedGiteaConfig.url, destinationProvider),
      });
      if (validatedNotificationConfig) {
        processedNotificationConfig = mergeNotificationSecrets(
          validatedNotificationConfig,
          parseStoredJson(existingConfig?.notificationConfig),
          removedNotificationSecrets
        );
      }
    } catch (error) {
      if (error instanceof SecretHostChangedError) {
        return new Response(
          JSON.stringify({ success: false, message: error.message }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      throw error;
    }

    // Map schedule and cleanup configs to database schema
    const processedScheduleConfig = mapUiScheduleToDb(
      scheduleConfig,
      existingConfig ? existingConfig.scheduleConfig : undefined
    );
    const processedCleanupConfig = mapUiCleanupToDb(
      cleanupConfig,
      existingConfig ? existingConfig.cleanupConfig : undefined
    );

    if (existingConfig) {
      // Update path
      const updateFields: Record<string, any> = {
        githubConfig: mappedGithubConfig,
        giteaConfig: mappedGiteaConfig,
        scheduleConfig: processedScheduleConfig,
        cleanupConfig: processedCleanupConfig,
        updatedAt: new Date(),
      };
      if (processedNotificationConfig) {
        updateFields.notificationConfig = processedNotificationConfig;
      }
      await db
        .update(configs)
        .set(updateFields)
        .where(eq(configs.id, existingConfig.id));

      return new Response(
        JSON.stringify({
          success: true,
          message: "Configuration updated successfully",
          configId: existingConfig.id,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Fallback user check (optional if you're always passing userId)
    const userExists = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (userExists.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Invalid userId. No matching user found.",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Create new config
    const configId = uuidv4();
    const insertValues: Record<string, any> = {
      id: configId,
      userId,
      name: "Default Configuration",
      isActive: true,
      githubConfig: mappedGithubConfig,
      giteaConfig: mappedGiteaConfig,
      include: [],
      exclude: [],
      scheduleConfig: processedScheduleConfig,
      cleanupConfig: processedCleanupConfig,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (processedNotificationConfig) {
      insertValues.notificationConfig = processedNotificationConfig;
    }
    await db.insert(configs).values(insertValues);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Configuration created successfully",
        configId,
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "config save", 500);
  }
};

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    // Fetch the configuration for the user — prefer the active config; fall back to
    // most-recently-updated so a stale inactive stub never wins over a populated
    // active row (see issue #271).
    const config = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    const locks = await loadConfigLocks(userId);

    // Sources for the Sources card: per-source repository counts and lock
    // state. Like the config below, tokens are never returned, only whether
    // one is saved. A failure must not take the Configuration page down.
    let sources: SourceApiItem[] = [];
    try {
      // Heal configs written outside the sources API (scripts, seeds):
      // seed the first source row before listing.
      const { ensureSourcesFromConfig } = await import("@/lib/sources");
      await ensureSourcesFromConfig(userId);
      sources = await loadSourceApiItems(userId);
    } catch (sourcesError) {
      console.warn(
        `[Config] Could not load sources for user ${userId}: ${
          sourcesError instanceof Error ? sourcesError.message : String(sourcesError)
        }`
      );
    }

    if (config.length === 0) {
      const defaultConfig = await createDefaultConfig({ userId });
      return configResponse(defaultConfig, locks, sources);
    }

    return configResponse(config[0], locks, sources);
  } catch (error) {
    return createSecureErrorResponse(error, "config fetch", 500);
  }
};

/** A JSON column that older rows may hold as a string. */
function parseStoredJson(value: unknown): Record<string, any> | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" ? (value as Record<string, any>) : undefined;
}

/**
 * The configuration as the browser sees it. Tokens and secrets are
 * write-only: each comes back empty, with hasToken or hasSecret saying
 * whether one is saved, so nothing that can read settings can copy them.
 */
function configResponse(
  row: Record<string, any>,
  locks: Awaited<ReturnType<typeof loadConfigLocks>>,
  sources: SourceApiItem[]
): Response {
  const githubConfig = parseStoredJson(row.githubConfig) ?? {};
  const giteaConfig = parseStoredJson(row.giteaConfig) ?? {};
  const scheduleConfig = parseStoredJson(row.scheduleConfig) ?? {};
  const cleanupConfig = parseStoredJson(row.cleanupConfig) ?? {};
  const uiConfig = mapDbToUiConfig({ ...row, githubConfig, giteaConfig });
  const notificationConfig = parseStoredJson(row.notificationConfig);

  return new Response(
    JSON.stringify({
      ...row,
      ...uiConfig,
      githubConfig: {
        ...uiConfig.githubConfig,
        token: "",
        hasToken: hasValue(githubConfig.token),
      },
      giteaConfig: {
        ...uiConfig.giteaConfig,
        token: "",
        hasToken: hasValue(giteaConfig.token),
      },
      scheduleConfig: {
        ...mapDbScheduleToUi(scheduleConfig as any),
        lastRun: scheduleConfig.lastRun,
        nextRun: scheduleConfig.nextRun,
      },
      cleanupConfig: {
        ...mapDbCleanupToUi(cleanupConfig as any),
        lastRun: cleanupConfig.lastRun,
        nextRun: cleanupConfig.nextRun,
      },
      notificationConfig: notificationConfig
        ? redactNotificationSecrets(notificationConfig)
        : row.notificationConfig ?? null,
      locks,
      sources,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
