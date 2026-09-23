import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_ORGANIZATIONS_VIEW,
  getOrganizationsView,
  setOrganizationsView,
  subscribeToOrganizationsViewChange,
  type OrganizationsViewMode,
} from "@/lib/utils/organizations-view";

const getServerSnapshot = (): OrganizationsViewMode => DEFAULT_ORGANIZATIONS_VIEW;

/**
 * Cards or list on the Organizations page (#428). The choice is kept in
 * localStorage and shared across tabs.
 */
export function useOrganizationsView() {
  const view = useSyncExternalStore(
    subscribeToOrganizationsViewChange,
    getOrganizationsView,
    getServerSnapshot
  );

  const setView = useCallback((next: OrganizationsViewMode) => {
    setOrganizationsView(next);
  }, []);

  return { view, setView };
}
