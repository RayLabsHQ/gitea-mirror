/**
 * OpenID Connect (OIDC) authentication implementation
 * Supports standard OIDC providers like Authentik, Keycloak, Auth0, etc.
 */

import { ENV, AuthConfig } from "@/lib/config";
import { db, users } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import jwt from "jsonwebtoken";
import type { User } from "@/lib/db/schema";

const JWT_SECRET = ENV.JWT_SECRET;

export interface OIDCConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface OIDCUserInfo {
  sub: string; // Subject (unique user ID)
  preferred_username?: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  groups?: string[];
}

export interface OIDCTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
}

/**
 * Get OIDC configuration
 */
export function getOIDCConfig(): OIDCConfig {
  return {
    issuerUrl: ENV.AUTH.OIDC.ISSUER_URL,
    clientId: ENV.AUTH.OIDC.CLIENT_ID,
    clientSecret: ENV.AUTH.OIDC.CLIENT_SECRET,
    redirectUri: AuthConfig.getOIDCRedirectURI(),
    scopes: ENV.AUTH.OIDC.SCOPES,
  };
}

/**
 * Discover OIDC endpoints from the issuer
 */
export async function discoverOIDCEndpoints(issuerUrl: string) {
  try {
    const wellKnownUrl = `${issuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await fetch(wellKnownUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch OIDC configuration: ${response.statusText}`);
    }
    
    const config = await response.json();
    
    return {
      authorizationEndpoint: config.authorization_endpoint,
      tokenEndpoint: config.token_endpoint,
      userinfoEndpoint: config.userinfo_endpoint,
      jwksUri: config.jwks_uri,
      issuer: config.issuer,
    };
  } catch (error) {
    console.error("OIDC: Failed to discover endpoints:", error);
    throw error;
  }
}

/**
 * Generate OIDC authorization URL with state and nonce
 */
export async function generateAuthorizationUrl(state?: string, nonce?: string): Promise<string> {
  const config = getOIDCConfig();
  const endpoints = await discoverOIDCEndpoints(config.issuerUrl);
  
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state: state || crypto.randomUUID(),
  });
  
  // Add nonce if provided (recommended for additional security)
  if (nonce) {
    params.append("nonce", nonce);
  }
  
  return `${endpoints.authorizationEndpoint}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(code: string): Promise<OIDCTokenResponse> {
  const config = getOIDCConfig();
  const endpoints = await discoverOIDCEndpoints(config.issuerUrl);
  
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  
  const response = await fetch(endpoints.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.statusText} - ${errorText}`);
  }
  
  return await response.json();
}

/**
 * Get user information from OIDC provider
 */
export async function getUserInfo(accessToken: string): Promise<OIDCUserInfo> {
  const config = getOIDCConfig();
  const endpoints = await discoverOIDCEndpoints(config.issuerUrl);
  
  const response = await fetch(endpoints.userinfoEndpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.statusText}`);
  }
  
  return await response.json();
}

/**
 * Decode and validate ID token
 * Note: For production use, implement proper JWT signature validation using JWKS
 */
export function decodeIdToken(idToken: string, issuer: string): any {
  try {
    // Split the token into parts
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid ID token format");
    }
    
    // Decode the payload
    const payload = JSON.parse(atob(parts[1]));
    
    // Basic validation
    if (!payload.sub) {
      throw new Error("ID token missing subject");
    }
    
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      throw new Error("ID token expired");
    }
    
    // Validate issuer
    if (payload.iss !== issuer) {
      throw new Error(`ID token issuer mismatch. Expected: ${issuer}, Got: ${payload.iss}`);
    }
    
    // TODO: Implement proper JWT signature validation using the provider's JWKS
    // This is critical for production security
    console.warn("OIDC: JWT signature validation not implemented - security risk in production");
    
    return payload;
  } catch (error) {
    console.error("OIDC: Failed to decode ID token:", error);
    throw error;
  }
}

/**
 * Find or create user based on OIDC information
 */
export async function findOrCreateOIDCUser(userInfo: OIDCUserInfo): Promise<User | null> {
  try {
    // Extract user data using configured claims
    const username = userInfo[ENV.AUTH.OIDC.USERNAME_CLAIM as keyof OIDCUserInfo] as string || userInfo.preferred_username || userInfo.sub;
    const email = userInfo[ENV.AUTH.OIDC.EMAIL_CLAIM as keyof OIDCUserInfo] as string || userInfo.email;
    const displayName = userInfo[ENV.AUTH.OIDC.NAME_CLAIM as keyof OIDCUserInfo] as string || userInfo.name;
    
    if (!username || !email) {
      console.error("OIDC: Missing required user information (username or email)");
      return null;
    }
    
    // Try to find existing user by external ID
    let existingUser = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.authProvider, "oidc"),
          eq(users.externalId, userInfo.sub)
        )
      )
      .limit(1);
    
    if (!existingUser.length) {
      // Try to find by email
      existingUser = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    }
    
    if (existingUser.length > 0) {
      // Update existing user
      const updatedUser = await db
        .update(users)
        .set({
          displayName,
          authProvider: "oidc",
          externalId: userInfo.sub,
          externalUsername: username,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, existingUser[0].id))
        .returning();
      
      return updatedUser[0];
    }
    
    // Create new user if auto-creation is enabled
    if (!ENV.AUTH.OIDC.AUTO_CREATE_USERS) {
      console.warn(`OIDC: User ${username} not found and auto-creation is disabled`);
      return null;
    }
    
    // Generate unique username
    let finalUsername = username;
    let counter = 1;
    
    while (true) {
      const existingByUsername = await db
        .select()
        .from(users)
        .where(eq(users.username, finalUsername))
        .limit(1);
      
      if (existingByUsername.length === 0) {
        break;
      }
      
      finalUsername = `${username}_${counter}`;
      counter++;
    }
    
    // Create new user
    const newUser = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        username: finalUsername,
        email,
        displayName,
        authProvider: "oidc",
        externalId: userInfo.sub,
        externalUsername: username,
        isActive: true,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    
    console.log(`OIDC: Created new user ${finalUsername} for external user ${username}`);
    return newUser[0];
    
  } catch (error) {
    console.error("OIDC: Error finding/creating user:", error);
    return null;
  }
}

/**
 * Complete OIDC authentication flow
 */
export async function completeOIDCAuth(code: string): Promise<{ user: User; token: string } | null> {
  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);
    
    // Validate ID token if present
    if (tokens.id_token) {
      const config = getOIDCConfig();
      const endpoints = await discoverOIDCEndpoints(config.issuerUrl);
      decodeIdToken(tokens.id_token, endpoints.issuer);
    }
    
    // Get user information
    const userInfo = await getUserInfo(tokens.access_token);
    
    // Find or create user
    const user = await findOrCreateOIDCUser(userInfo);
    if (!user) {
      return null;
    }
    
    // Check if user is active
    if (!user.isActive) {
      console.warn(`OIDC: User ${user.username} is inactive`);
      return null;
    }
    
    // Generate JWT token
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "7d" });
    
    return { user, token };
    
  } catch (error) {
    console.error("OIDC: Authentication error:", error);
    return null;
  }
}
