/**
 * Bun test setup file
 * This file is automatically loaded before running tests
 */

import { mock } from "bun:test";

// Set NODE_ENV to test
process.env.NODE_ENV = "test";

// Mock setTimeout globally to prevent hanging tests
const originalSetTimeout = global.setTimeout;
global.setTimeout = ((fn: Function, delay?: number) => {
  // In tests, execute immediately or with minimal delay
  if (delay && delay > 100) {
    // For long delays, execute immediately
    Promise.resolve().then(() => fn());
  } else {
    // For short delays, use setImmediate-like behavior
    Promise.resolve().then(() => fn());
  }
  return 0;
}) as any;

// Restore setTimeout for any code that needs real timing
(global as any).__originalSetTimeout = originalSetTimeout;

// Mock the database module to prevent real database access during tests
mock.module("@/lib/db", () => {
  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
          // Sources queries order or group before awaiting; resolve to no
          // rows so callers see an empty result.
          orderBy: () => Promise.resolve([]),
          groupBy: () => Promise.resolve([])
        })
      })
    }),
    insert: (table: any) => ({
      values: (data: any) => Promise.resolve({ insertedId: "mock-id" })
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve()
      })
    }),
    delete: () => ({
      where: () => Promise.resolve()
    })
  };

  return {
    db: mockDb,
    users: {},
    events: {},
    configs: {},
    sources: {},
    repositories: {},
    mirrorJobs: {},
    organizations: {},
    sessions: {},
    accounts: {},
    verificationTokens: {},
    oauthApplications: {},
    oauthAccessTokens: {},
    oauthConsent: {},
    ssoProviders: {}
  };
});

// Mock drizzle-orm to prevent database migrations from running
mock.module("drizzle-orm/bun-sqlite/migrator", () => {
  return {
    migrate: () => {}
  };
});

// Mock config encryption utilities
mock.module("@/lib/utils/config-encryption", () => {
  return {
    decryptConfigTokens: (config: any) => {
      // Return the config as-is for tests
      return config;
    },
    encryptConfigTokens: (config: any) => {
      // Return the config as-is for tests
      return config;
    },
    getDecryptedGitHubToken: (config: any) => {
      // Return the token as-is for tests
      return config.githubConfig?.token || "";
    },
    getDecryptedGiteaToken: (config: any) => {
      // Return the token as-is for tests
      return config.giteaConfig?.token || "";
    }
  };
});

// Mock the helpers module to prevent database operations
mock.module("@/lib/helpers", () => {
  const mockCreateMirrorJob = mock(() => Promise.resolve("mock-job-id"));
  const mockCreateEvent = mock(() => Promise.resolve());
  
  return {
    createMirrorJob: mockCreateMirrorJob,
    createEvent: mockCreateEvent,
    // Add other helpers as needed
  };
});

// Add DOM testing support if needed
// import { DOMParser } from "linkedom";
// global.DOMParser = DOMParser;
