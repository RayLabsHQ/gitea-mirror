import type { APIRoute } from "astro";
import { db, configs, users } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { createSecureErrorResponse } from "@/lib/utils";
import { 
  mapUiToDbConfig, 
  mapDbToUiConfig, 
  mapUiScheduleToDb, 
  mapUiCleanupToDb,
  mapDbScheduleToUi,
  mapDbCleanupToUi 
} from "@/lib/utils/config-mapper";
import { encrypt, decrypt } from "@/lib/utils/encryption";
import { createDefaultConfig } from "@/lib/utils/config-defaults";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { notificationConfigSchema } from "@/lib/db/schema";

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

    let validatedNotificationConfig: any = undefined;
    if (notificationConfig !== undefined) {
      const parsed = notificationConfigSchema.safeParse(notificationConfig);
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
    }

    // Fetch existing config
    const existingConfigResult = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    const existingConfig = existingConfigResult[0];

    // Map UI structure to database schema structure first
    const { githubConfig: mappedGithubConfig, giteaConfig: mappedGiteaConfig } = mapUiToDbConfig(
      githubConfig,
      giteaConfig,
      mirrorOptions,
      advancedOptions
    );
    
    // Preserve tokens if fields are empty
    if (existingConfig) {
      try {
        const existingGithub =
          typeof existingConfig.githubConfig === "string"
            ? JSON.parse(existingConfig.githubConfig)
            : existingConfig.githubConfig;

        const existingGitea =
          typeof existingConfig.giteaConfig === "string"
            ? JSON.parse(existingConfig.giteaConfig)
            : existingConfig.giteaConfig;

        // Decrypt existing tokens before preserving
        if (!mappedGithubConfig.token && existingGithub.token) {
          mappedGithubConfig.token = decrypt(existingGithub.token);
        }

        if (!mappedGiteaConfig.token && existingGitea.token) {
          mappedGiteaConfig.token = decrypt(existingGitea.token);
        }
      } catch (tokenError) {
        console.error("Failed to preserve tokens:", tokenError);
      }
    }
    
    // Encrypt tokens before saving
    if (mappedGithubConfig.token) {
      mappedGithubConfig.token = encrypt(mappedGithubConfig.token);
    }
    
    if (mappedGiteaConfig.token) {
      mappedGiteaConfig.token = encrypt(mappedGiteaConfig.token);
    }

    // Map schedule and cleanup configs to database schema
    const processedScheduleConfig = mapUiScheduleToDb(
      scheduleConfig,
      existingConfig ? existingConfig.scheduleConfig : undefined
    );
    const processedCleanupConfig = mapUiCleanupToDb(cleanupConfig);

    // Process notification config if provided
    let processedNotificationConfig: any = undefined;
    if (validatedNotificationConfig) {
      processedNotificationConfig = { ...validatedNotificationConfig };
      // Encrypt ntfy token if present
      if (processedNotificationConfig.ntfy?.token) {
        processedNotificationConfig.ntfy = {
          ...processedNotificationConfig.ntfy,
          token: encrypt(processedNotificationConfig.ntfy.token),
        };
      }
      // Encrypt apprise token if present
      if (processedNotificationConfig.apprise?.token) {
        processedNotificationConfig.apprise = {
          ...processedNotificationConfig.apprise,
          token: encrypt(processedNotificationConfig.apprise.token),
        };
      }
    }

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

    // Fetch the configuration for the user
    const config = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .limit(1);

    if (config.length === 0) {
      // Create default configuration for the user
      const defaultConfig = await createDefaultConfig({ userId });
      
      // Map the created config to UI format
      const uiConfig = mapDbToUiConfig(defaultConfig);
      const uiScheduleConfig = mapDbScheduleToUi(defaultConfig.scheduleConfig);
      const uiCleanupConfig = mapDbCleanupToUi(defaultConfig.cleanupConfig);
      
      return new Response(
        JSON.stringify({
          ...defaultConfig,
          ...uiConfig,
          scheduleConfig: uiScheduleConfig,
          cleanupConfig: uiCleanupConfig,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Map database structure to UI structure
    const dbConfig = config[0];
    
    // Decrypt tokens before sending to UI
    try {
      const githubConfig = typeof dbConfig.githubConfig === "string"
        ? JSON.parse(dbConfig.githubConfig)
        : dbConfig.githubConfig;
      
      const giteaConfig = typeof dbConfig.giteaConfig === "string"
        ? JSON.parse(dbConfig.giteaConfig)
        : dbConfig.giteaConfig;
      
      // Decrypt tokens
      if (githubConfig.token) {
        githubConfig.token = decrypt(githubConfig.token);
      }
      
      if (giteaConfig.token) {
        giteaConfig.token = decrypt(giteaConfig.token);
      }
      
      // Create modified config with decrypted tokens
      const decryptedConfig = {
        ...dbConfig,
        githubConfig,
        giteaConfig
      };

      const uiConfig = mapDbToUiConfig(decryptedConfig);

      // Map schedule and cleanup configs to UI format
      const uiScheduleConfig = mapDbScheduleToUi(dbConfig.scheduleConfig);
      const uiCleanupConfig = mapDbCleanupToUi(dbConfig.cleanupConfig);

      // Decrypt notification config tokens
      let notificationConfig = dbConfig.notificationConfig;
      if (notificationConfig) {
        notificationConfig = { ...notificationConfig };
        if (notificationConfig.ntfy?.token) {
          try {
            notificationConfig.ntfy = { ...notificationConfig.ntfy, token: decrypt(notificationConfig.ntfy.token) };
          } catch {
            // Clear token on decryption failure to prevent double-encryption on next save
            notificationConfig.ntfy = { ...notificationConfig.ntfy, token: "" };
          }
        }
        if (notificationConfig.apprise?.token) {
          try {
            notificationConfig.apprise = { ...notificationConfig.apprise, token: decrypt(notificationConfig.apprise.token) };
          } catch {
            notificationConfig.apprise = { ...notificationConfig.apprise, token: "" };
          }
        }
      }

      return new Response(JSON.stringify({
        ...dbConfig,
        ...uiConfig,
        scheduleConfig: {
          ...uiScheduleConfig,
          lastRun: dbConfig.scheduleConfig.lastRun,
          nextRun: dbConfig.scheduleConfig.nextRun,
        },
        cleanupConfig: {
          ...uiCleanupConfig,
          lastRun: dbConfig.cleanupConfig.lastRun,
          nextRun: dbConfig.cleanupConfig.nextRun,
        },
        notificationConfig,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Failed to decrypt tokens:", error);
      // Return config without decrypting tokens if there's an error
      const uiConfig = mapDbToUiConfig(dbConfig);
      const uiScheduleConfig = mapDbScheduleToUi(dbConfig.scheduleConfig);
      const uiCleanupConfig = mapDbCleanupToUi(dbConfig.cleanupConfig);

      return new Response(JSON.stringify({
        ...dbConfig,
        ...uiConfig,
        scheduleConfig: {
          ...uiScheduleConfig,
          lastRun: dbConfig.scheduleConfig.lastRun,
          nextRun: dbConfig.scheduleConfig.nextRun,
        },
        cleanupConfig: {
          ...uiCleanupConfig,
          lastRun: dbConfig.cleanupConfig.lastRun,
          nextRun: dbConfig.cleanupConfig.nextRun,
        },
        notificationConfig: dbConfig.notificationConfig,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (error) {
    return createSecureErrorResponse(error, "config fetch", 500);
  }
};
