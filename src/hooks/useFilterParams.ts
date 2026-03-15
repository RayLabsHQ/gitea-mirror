import { useState, useEffect } from "react";
import type { FilterParams } from "@/types/filter";

const FILTER_KEYS: (keyof FilterParams)[] = [
  "searchTerm",
  "status",
  "membershipRole",
  "owner",
  "organization",
  "sort",
  "type",
  "name",
];

export const useFilterParams = (
  defaultFilters: FilterParams,
  debounceDelay = 300
) => {
  const getInitialFilter = (): FilterParams => {
    if (typeof window === "undefined") return defaultFilters;

    const params = new URLSearchParams(window.location.search);
    const result: FilterParams = { ...defaultFilters };

    FILTER_KEYS.forEach((key) => {
      const value = params.get(key);
      if (value !== null) {
        (result as any)[key] = value;
      }
    });

    return result;
  };

  const [filter, setFilter] = useState<FilterParams>(() => getInitialFilter());

  // Debounced URL update
  useEffect(() => {
    const handler = setTimeout(() => {
      const params = new URLSearchParams();

      FILTER_KEYS.forEach((key) => {
        const value = filter[key];
        if (value) {
          params.set(key, String(value));
        }
      });

      const newUrl = `${window.location.pathname}?${params.toString()}`;
      window.history.replaceState({}, "", newUrl);
    }, debounceDelay);

    return () => clearTimeout(handler); // Cleanup on unmount or when `filter` changes
  }, [filter, debounceDelay]);

  return {
    filter,
    setFilter,
  };
};
