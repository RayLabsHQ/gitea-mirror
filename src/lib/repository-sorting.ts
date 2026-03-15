import type { Repository } from "@/lib/db/schema";

export type RepositorySortOrder =
  | "imported-desc"
  | "imported-asc"
  | "updated-desc"
  | "updated-asc"
  | "name-asc"
  | "name-desc";

function getTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function sortRepositories(
  repositories: Repository[],
  sortOrder: string | undefined,
): Repository[] {
  const order = (sortOrder ?? "imported-desc") as RepositorySortOrder;

  return [...repositories].sort((a, b) => {
    switch (order) {
      case "imported-asc":
        return getTimestamp(a.importedAt) - getTimestamp(b.importedAt);
      case "updated-desc":
        return getTimestamp(b.updatedAt) - getTimestamp(a.updatedAt);
      case "updated-asc":
        return getTimestamp(a.updatedAt) - getTimestamp(b.updatedAt);
      case "name-asc":
        return a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" });
      case "name-desc":
        return b.fullName.localeCompare(a.fullName, undefined, { sensitivity: "base" });
      case "imported-desc":
      default:
        return getTimestamp(b.importedAt) - getTimestamp(a.importedAt);
    }
  });
}
