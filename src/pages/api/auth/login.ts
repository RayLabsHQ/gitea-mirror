import type { APIRoute } from "astro";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { ENV } from "@/lib/config";

const JWT_SECRET = ENV.JWT_SECRET;

export const POST: APIRoute = async ({ request }) => {
  const { username, password } = await request.json();

  if (!username || !password) {
    return new Response(
      JSON.stringify({ error: "Username and password are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const user = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user.length) {
    return new Response(
      JSON.stringify({ error: "Invalid username or password" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Check if user is using external authentication
  if (user[0].authProvider !== "local") {
    return new Response(
      JSON.stringify({ 
        error: `This account uses ${user[0].authProvider.toUpperCase()} authentication. Please use the appropriate login method.` 
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Check if user has a password (required for local auth)
  if (!user[0].password) {
    return new Response(
      JSON.stringify({ error: "Invalid account configuration. Please contact your administrator." }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const isPasswordValid = await bcrypt.compare(password, user[0].password);

  if (!isPasswordValid) {
    return new Response(
      JSON.stringify({ error: "Invalid username or password" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Update last login timestamp
  await db
    .update(users)
    .set({ 
      lastLoginAt: new Date(),
      updatedAt: new Date() 
    })
    .where(eq(users.id, user[0].id));

  const { password: _, ...userWithoutPassword } = user[0];
  const token = jwt.sign({ id: user[0].id }, JWT_SECRET, { expiresIn: "7d" });

  const isProduction = ENV.NODE_ENV === "production";
  const cookieFlags = isProduction 
    ? "HttpOnly; SameSite=Strict; Secure" 
    : "HttpOnly; SameSite=Strict";

  return new Response(JSON.stringify({ token, user: userWithoutPassword }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `token=${token}; Path=/; ${cookieFlags}; Max-Age=${
        60 * 60 * 24 * 7
      }`,
    },
  });
};
