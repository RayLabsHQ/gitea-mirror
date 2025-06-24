import type { APIRoute } from "astro";
import { db, configs } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getAuthStatus } from "@/lib/auth/middleware";

export const GET: APIRoute = async ({ request }) => {
  const authStatus = await getAuthStatus(request);

  if (!authStatus.authenticated) {
    if (!authStatus.hasUsers) {
      return new Response(JSON.stringify({ error: "No users found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const user = authStatus.user!;
    const { password, ...userWithoutPassword } = user;

    const configResult = await db
      .select({
        scheduleConfig: configs.scheduleConfig,
      })
      .from(configs)
      .where(and(eq(configs.userId, user.id), eq(configs.isActive, true)))
      .limit(1);

    const scheduleConfig = configResult[0]?.scheduleConfig;

    const syncEnabled = scheduleConfig?.enabled ?? false;
    const syncInterval = scheduleConfig?.interval ?? 3600;
    const lastSync = scheduleConfig?.lastRun ?? null;
    const nextSync = scheduleConfig?.nextRun ?? null;

    return new Response(
      JSON.stringify({
        ...userWithoutPassword,
        syncEnabled,
        syncInterval,
        lastSync,
        nextSync,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: "Invalid token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
};
