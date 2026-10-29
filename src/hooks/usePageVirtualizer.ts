import { useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useNavigation } from "@/components/layout/MainLayout";

/**
 * A virtualizer for a list that scrolls with the page (MainLayout's main
 * section) instead of in a box of its own, so only the rows near the viewport
 * are in the DOM. Put `listRef` on the list's container, give it the
 * virtualizer's total size as its height, and place each row at
 * `start - virtualizer.options.scrollMargin`.
 */
export function usePageVirtualizer({
  count,
  estimateSize,
  overscan = 5,
  getItemKey,
}: {
  count: number;
  estimateSize: (index: number) => number;
  overscan?: number;
  /** A stable key per row keeps measured heights with their row across filtering. */
  getItemKey?: (index: number) => string | number;
}) {
  const { pageScrollElement } = useNavigation();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Where the list starts in the page's scroll content. Anything above it can
  // change height, so it is measured after every render.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !pageScrollElement) return;
    const next = Math.round(
      list.getBoundingClientRect().top - pageScrollElement.getBoundingClientRect().top + pageScrollElement.scrollTop
    );
    if (next !== scrollMargin) setScrollMargin(next);
  });

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => pageScrollElement,
    estimateSize,
    overscan,
    scrollMargin,
    ...(getItemKey ? { getItemKey } : {}),
  });

  return { listRef, virtualizer };
}
