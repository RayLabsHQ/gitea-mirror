import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { runsIsolated } from "@/tests/isolated";

// The module mocks below would leak into the test files that run after
// this one, so the mocks and tests only run in a child process.
const isChild = runsIsolated(import.meta.path);
import { drizzle } from "drizzle-orm/bun-sqlite";

// Silence console logs during tests
let originalConsoleLog: typeof console.log;

if (isChild) beforeAll(() => {
  // Save original console.log
  originalConsoleLog = console.log;
  // Replace with no-op function
  console.log = () => {};
});

if (isChild) afterAll(() => {
  // Restore original console.log
  console.log = originalConsoleLog;
});

// Mock the database module
if (isChild) mock.module("bun:sqlite", () => {
  return {
    Database: mock(function() {
      return {
        query: mock(() => ({
          all: mock(() => []),
          run: mock(() => ({}))
        }))
      };
    })
  };
});

// Mock the database tables
describe.skipIf(!isChild)("Database Schema", () => {
  test("database connection can be created", async () => {
    // Import the db from the module
    const { db } = await import("./index");

    // Check that db is defined
    expect(db).toBeDefined();
  });
});
