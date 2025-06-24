import type { APIRoute } from "astro";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db, users } from "@/lib/db";
import { eq, or } from "drizzle-orm";
import { ENV } from "@/lib/config";

const JWT_SECRET = ENV.JWT_SECRET;

export const POST: APIRoute = async ({ request }) => {
  const { username, email, password } = await request.json();

  if (!username || !email || !password) {
    return new Response(
      JSON.stringify({ error: "Username, email, and password are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Check if username or email already exists
  const existingUser = await db
    .select()
    .from(users)
    .where(or(eq(users.username, username), eq(users.email, email)))
    .limit(1);

  if (existingUser.length) {
    return new Response(
      JSON.stringify({ error: "Username or email already exists" }),
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Generate UUID
  const id = crypto.randomUUID();

  // Create user
  const newUser = await db
    .insert(users)
    .values({
      id,
      username,
      email,
      password: hashedPassword,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const { password: _, ...userWithoutPassword } = newUser[0];
  const token = jwt.sign({ id: newUser[0].id }, JWT_SECRET, {
    expiresIn: "7d",
  });

  // Determine if we're in production
  const isProduction = ENV.NODE_ENV === "production";
  const cookieFlags = isProduction 
    ? "HttpOnly; SameSite=Strict; Secure" 
    : "HttpOnly; SameSite=Strict";

  return new Response(JSON.stringify({ token, user: userWithoutPassword }), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `token=${token}; Path=/; ${cookieFlags}; Max-Age=${
        60 * 60 * 24 * 7
      }`,
    },
  });
};
