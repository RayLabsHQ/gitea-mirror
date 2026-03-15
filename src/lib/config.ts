/**
 * Application configuration
 */

// Environment variables
export const ENV = {
  // Runtime environment (development, production, test)
  NODE_ENV: process.env.NODE_ENV || "development",

  // Database URL - use SQLite by default
  get DATABASE_URL() {
    // If explicitly set, use the provided DATABASE_URL
    if (process.env.DATABASE_URL) {
      return process.env.DATABASE_URL;
    }

    // Otherwise, use the default database
    return "sqlite://data/gitea-mirror.db";
  },

  // Better Auth secret for authentication
  get BETTER_AUTH_SECRET(): string {
    const secret = process.env.BETTER_AUTH_SECRET;
    const knownInsecureDefaults = [
      "your-secret-key-change-this-in-production",
      "dev-only-insecure-secret-do-not-use-in-production",
    ];
    if (!secret || knownInsecureDefaults.includes(secret)) {
      if (process.env.NODE_ENV === "production") {
        console.error(
          "\x1b[31m[SECURITY WARNING]\x1b[0m BETTER_AUTH_SECRET is missing or using an insecure default. " +
          "Set a strong secret: openssl rand -base64 32"
        );
      }
      return secret || "dev-only-insecure-secret-do-not-use-in-production";
    }
    return secret;
  },

  // Server host and port
  HOST: process.env.HOST || "localhost",
  PORT: parseInt(process.env.PORT || "4321", 10),
};
