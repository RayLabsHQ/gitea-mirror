/**
 * JWKS (JSON Web Key Set) utilities for validating JWT signatures
 */

import { ENV } from "@/lib/config";

export interface JWK {
  kty: string;
  use?: string;
  key_ops?: string[];
  alg?: string;
  kid?: string;
  x5c?: string[];
  x5t?: string;
  x5u?: string;
  n?: string; // RSA modulus
  e?: string; // RSA exponent
  x?: string; // EC x coordinate
  y?: string; // EC y coordinate
  crv?: string; // EC curve
}

export interface JWKS {
  keys: JWK[];
}

// Cache for JWKS to avoid frequent fetches
const jwksCache = new Map<string, { jwks: JWKS; fetchedAt: number }>();
const CACHE_DURATION = 3600000; // 1 hour in milliseconds

/**
 * Fetch JWKS from the provider
 */
export async function fetchJWKS(jwksUri: string): Promise<JWKS> {
  // Check cache first
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.fetchedAt < CACHE_DURATION) {
    return cached.jwks;
  }

  try {
    const response = await fetch(jwksUri);
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.statusText}`);
    }

    const jwks = await response.json();
    
    // Cache the result
    jwksCache.set(jwksUri, { jwks, fetchedAt: Date.now() });
    
    return jwks;
  } catch (error) {
    console.error("Failed to fetch JWKS:", error);
    throw error;
  }
}

/**
 * Extract key ID from JWT header
 */
export function extractKeyId(token: string): string | null {
  try {
    const [headerB64] = token.split(".");
    const header = JSON.parse(atob(headerB64));
    return header.kid || null;
  } catch (error) {
    console.error("Failed to extract key ID from JWT:", error);
    return null;
  }
}

/**
 * Find the matching key in JWKS
 */
export function findKey(jwks: JWKS, kid: string | null): JWK | null {
  if (!kid) {
    // If no kid, try to find a suitable key
    return jwks.keys.find(key => key.use === "sig" || !key.use) || null;
  }
  
  return jwks.keys.find(key => key.kid === kid) || null;
}

/**
 * Convert base64url to base64
 */
function base64urlToBase64(str: string): string {
  return str.replace(/-/g, "+").replace(/_/g, "/");
}

/**
 * Import RSA public key from JWK
 */
async function importRSAKey(jwk: JWK): Promise<CryptoKey> {
  if (!jwk.n || !jwk.e) {
    throw new Error("Invalid RSA key: missing n or e");
  }

  // Convert base64url to ArrayBuffer
  const nBytes = Uint8Array.from(atob(base64urlToBase64(jwk.n)), c => c.charCodeAt(0));
  const eBytes = Uint8Array.from(atob(base64urlToBase64(jwk.e)), c => c.charCodeAt(0));

  // Import the public key
  return await crypto.subtle.importKey(
    {
      kty: "RSA",
      n: jwk.n,
      e: jwk.e,
      alg: jwk.alg || "RS256",
      ext: true,
    },
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: jwk.alg === "RS384" ? "SHA-384" : jwk.alg === "RS512" ? "SHA-512" : "SHA-256" },
    },
    false,
    ["verify"]
  );
}

/**
 * Verify JWT signature using JWKS
 */
export async function verifyJWTSignature(token: string, jwksUri: string): Promise<boolean> {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !signatureB64) {
      throw new Error("Invalid JWT format");
    }

    // Fetch JWKS
    const jwks = await fetchJWKS(jwksUri);
    
    // Extract key ID from token header
    const kid = extractKeyId(token);
    
    // Find the matching key
    const jwk = findKey(jwks, kid);
    if (!jwk) {
      throw new Error(`No matching key found in JWKS for kid: ${kid}`);
    }

    // Only support RSA keys for now
    if (jwk.kty !== "RSA") {
      throw new Error(`Unsupported key type: ${jwk.kty}`);
    }

    // Import the public key
    const publicKey = await importRSAKey(jwk);

    // Prepare data for verification
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(atob(base64urlToBase64(signatureB64)), c => c.charCodeAt(0));

    // Verify the signature
    const isValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signature,
      data
    );

    return isValid;
  } catch (error) {
    console.error("JWT signature verification failed:", error);
    return false;
  }
}

/**
 * Validate and decode ID token with signature verification
 */
export async function validateIDToken(idToken: string, issuer: string, jwksUri: string): Promise<any> {
  try {
    // First verify the signature
    const isValidSignature = await verifyJWTSignature(idToken, jwksUri);
    if (!isValidSignature) {
      throw new Error("Invalid JWT signature");
    }

    // Decode and validate claims
    const parts = idToken.split(".");
    const payload = JSON.parse(atob(parts[1]));

    // Validate standard claims
    if (!payload.sub) {
      throw new Error("ID token missing subject");
    }

    if (payload.exp && Date.now() / 1000 > payload.exp) {
      throw new Error("ID token expired");
    }

    if (payload.iss !== issuer) {
      throw new Error(`ID token issuer mismatch. Expected: ${issuer}, Got: ${payload.iss}`);
    }

    // Validate audience if OIDC client ID is available
    if (ENV.AUTH.OIDC.CLIENT_ID && payload.aud) {
      const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audience.includes(ENV.AUTH.OIDC.CLIENT_ID)) {
        throw new Error("ID token audience mismatch");
      }
    }

    return payload;
  } catch (error) {
    console.error("ID token validation failed:", error);
    throw error;
  }
}