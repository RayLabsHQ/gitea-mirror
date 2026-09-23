import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_ORGANIZATIONS_VIEW,
  ORGANIZATIONS_VIEW_CHANGE_EVENT,
  ORGANIZATIONS_VIEW_STORAGE_KEY,
  getOrganizationsView,
  isOrganizationsViewMode,
  setOrganizationsView,
  subscribeToOrganizationsViewChange,
} from "./organizations-view";

// A minimal window and localStorage so the helper can be exercised
// without a DOM library. Both are removed again afterwards.
function installBrowserGlobals() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<(event: any) => void>>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  (globalThis as any).window = {
    addEventListener: (type: string, cb: (event: any) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: (event: any) => void) => {
      listeners.get(type)?.delete(cb);
    },
    dispatchEvent: (event: any) => {
      listeners.get(event.type)?.forEach((cb) => cb(event));
      return true;
    },
  };
  if (typeof (globalThis as any).CustomEvent === "undefined") {
    (globalThis as any).CustomEvent = class CustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }
  return { store, listeners };
}

describe("organizations view preference", () => {
  const hadWindow = typeof (globalThis as any).window !== "undefined";
  const hadStorage = typeof (globalThis as any).localStorage !== "undefined";
  const savedWindow = (globalThis as any).window;
  const savedStorage = (globalThis as any).localStorage;

  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  });

  afterEach(() => {
    if (hadWindow) (globalThis as any).window = savedWindow;
    else delete (globalThis as any).window;
    if (hadStorage) (globalThis as any).localStorage = savedStorage;
    else delete (globalThis as any).localStorage;
  });

  it("falls back to cards without a browser", () => {
    expect(getOrganizationsView()).toBe(DEFAULT_ORGANIZATIONS_VIEW);
    expect(DEFAULT_ORGANIZATIONS_VIEW).toBe("cards");
    // Setting without a window must not throw either.
    expect(() => setOrganizationsView("list")).not.toThrow();
  });

  it("only accepts the two known modes", () => {
    expect(isOrganizationsViewMode("cards")).toBe(true);
    expect(isOrganizationsViewMode("list")).toBe(true);
    expect(isOrganizationsViewMode("table")).toBe(false);
    expect(isOrganizationsViewMode(null)).toBe(false);
  });

  it("persists the choice and ignores garbage in storage", () => {
    const { store } = installBrowserGlobals();
    expect(getOrganizationsView()).toBe("cards");

    setOrganizationsView("list");
    expect(store.get(ORGANIZATIONS_VIEW_STORAGE_KEY)).toBe("list");
    expect(getOrganizationsView()).toBe("list");

    store.set(ORGANIZATIONS_VIEW_STORAGE_KEY, "sideways");
    expect(getOrganizationsView()).toBe("cards");
  });

  it("notifies subscribers in this tab and from the storage event", () => {
    const { listeners } = installBrowserGlobals();
    let calls = 0;
    const unsubscribe = subscribeToOrganizationsViewChange(() => {
      calls += 1;
    });

    setOrganizationsView("list");
    expect(calls).toBe(1);

    // Another tab changed it.
    listeners.get("storage")?.forEach((cb) => cb({ key: ORGANIZATIONS_VIEW_STORAGE_KEY }));
    expect(calls).toBe(2);
    // An unrelated key does nothing.
    listeners.get("storage")?.forEach((cb) => cb({ key: "timeFormat" }));
    expect(calls).toBe(2);

    unsubscribe();
    (globalThis as any).window.dispatchEvent(new CustomEvent(ORGANIZATIONS_VIEW_CHANGE_EVENT));
    expect(calls).toBe(2);
  });

  it("swallows a storage that throws", () => {
    installBrowserGlobals();
    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(getOrganizationsView()).toBe("cards");
    expect(() => setOrganizationsView("list")).not.toThrow();
  });
});
