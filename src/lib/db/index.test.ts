import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import type { Database } from "bun:sqlite";

// Mock the bun:sqlite module
mock.module("bun:sqlite", () => {
  return {
    Database: mock(function() {
      return {
        query: mock(() => ({
          all: mock(() => []),
          run: mock(() => ({})),
          get: mock(() => undefined)
        })),
        exec: mock(() => {}),
        prepare: mock(() => ({
          run: mock(() => {}),
          get: mock(() => undefined),
          all: mock(() => [])
        })),
        close: mock(() => {})
      };
    })
  };
});

// Mock the drizzle migrator
mock.module("drizzle-orm/bun-sqlite/migrator", () => {
  return {
    migrate: mock(async () => {
      // Mock successful migration
    })
  };
});

// Silence console logs during tests
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;

beforeAll(() => {
  originalConsoleLog = console.log;
  originalConsoleError = console.error;
  console.log = () => {};
  console.error = () => {};
});

afterAll(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

describe("Database Schema", () => {
  test("database connection can be created", async () => {
    const { getDb } = await import("./index");
    
    // Get database instance
    const db = await getDb();
    
    // Check that db is defined
    expect(db).toBeDefined();
  });

  test("exports schema types", async () => {
    const schemaExports = await import("./index");
    
    // Check that schema tables are exported
    expect(schemaExports.users).toBeDefined();
    expect(schemaExports.configs).toBeDefined();
    expect(schemaExports.repositories).toBeDefined();
    expect(schemaExports.organizations).toBeDefined();
    expect(schemaExports.mirrorJobs).toBeDefined();
    expect(schemaExports.events).toBeDefined();
    expect(schemaExports.authConfig).toBeDefined();
  });
});