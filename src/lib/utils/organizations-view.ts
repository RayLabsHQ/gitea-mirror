/**
 * Cards or list on the Organizations page (#428).
 *
 * A pure display preference, so it lives in localStorage next to the theme
 * and time format preferences rather than in the database. Reading is safe
 * during SSR and in tests, where localStorage does not exist.
 */

export type OrganizationsViewMode = "cards" | "list";

export const ORGANIZATIONS_VIEW_STORAGE_KEY = "organizationsView";
export const ORGANIZATIONS_VIEW_CHANGE_EVENT = "gitea-mirror:organizations-view-change";

export const DEFAULT_ORGANIZATIONS_VIEW: OrganizationsViewMode = "cards";

export function isOrganizationsViewMode(value: unknown): value is OrganizationsViewMode {
  return value === "cards" || value === "list";
}

export function getOrganizationsView(): OrganizationsViewMode {
  if (typeof localStorage === "undefined") return DEFAULT_ORGANIZATIONS_VIEW;
  try {
    const stored = localStorage.getItem(ORGANIZATIONS_VIEW_STORAGE_KEY);
    return isOrganizationsViewMode(stored) ? stored : DEFAULT_ORGANIZATIONS_VIEW;
  } catch {
    return DEFAULT_ORGANIZATIONS_VIEW;
  }
}

export function setOrganizationsView(mode: OrganizationsViewMode): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(ORGANIZATIONS_VIEW_STORAGE_KEY, mode);
    }
  } catch {
    // Persisting is best effort; listeners are still told.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(ORGANIZATIONS_VIEW_CHANGE_EVENT, { detail: mode }));
  }
}

/** Subscribe to changes from this tab and from other tabs. */
export function subscribeToOrganizationsViewChange(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ORGANIZATIONS_VIEW_STORAGE_KEY) callback();
  };
  window.addEventListener(ORGANIZATIONS_VIEW_CHANGE_EVENT, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ORGANIZATIONS_VIEW_CHANGE_EVENT, callback);
    window.removeEventListener("storage", onStorage);
  };
}
