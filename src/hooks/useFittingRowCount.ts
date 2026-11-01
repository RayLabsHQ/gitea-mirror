import { useLayoutEffect, useState } from "react";
import { useNavigation } from "@/components/layout/MainLayout";

/** Matches Tailwind's `lg`, where the dashboard lists sit side by side. */
const SIDE_BY_SIDE_QUERY = "(min-width: 1024px)";

/**
 * How many rows the dashboard lists can show before they run past the bottom
 * of the screen, so a tall screen shows more and a short one fewer.
 *
 * `container` holds the lists, each marked with `data-fit-rows`. A list is
 * measured as it is rendered: its first row, the average of the rows after it
 * (they carry the divider), and the padding and borders between the list and
 * the container. None of that depends on how many rows are shown, so a new
 * count measures the same as the last one and the layout settles in one pass.
 *
 * Below `lg` the lists stack, so they cannot both end at the screen's bottom,
 * and `fallback` is used.
 */
export function useFittingRowCount(
  container: HTMLElement | null,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const { pageScrollElement } = useNavigation();
  const [count, setCount] = useState(fallback);

  useLayoutEffect(() => {
    if (!container || !pageScrollElement) return;

    const measure = () => {
      if (!window.matchMedia(SIDE_BY_SIDE_QUERY).matches) {
        setCount(fallback);
        return;
      }

      const scrollStyle = getComputedStyle(pageScrollElement);
      const bottom =
        pageScrollElement.getBoundingClientRect().bottom - parseFloat(scrollStyle.paddingBottom);

      let fit: number | undefined;
      for (const list of container.querySelectorAll<HTMLElement>("[data-fit-rows]")) {
        const rows = list.children;
        if (rows.length === 0) continue;

        const listRect = list.getBoundingClientRect();
        const first = rows[0].getBoundingClientRect().height;
        const pitch = rows.length > 1 ? (listRect.height - first) / (rows.length - 1) : first + 1;
        if (first <= 0 || pitch <= 0) continue;

        // Padding and borders below the list, up to the container.
        let below = 0;
        for (let el = list.parentElement; el && el !== container; el = el.parentElement) {
          const style = getComputedStyle(el);
          below += parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
        }

        // Where the list starts with the page scrolled to the top.
        const top = listRect.top + pageScrollElement.scrollTop;
        const space = bottom - top - below;
        const rowsThatFit = space < first ? 0 : 1 + Math.floor((space - first) / pitch);
        fit = fit === undefined ? rowsThatFit : Math.min(fit, rowsThatFit);
      }

      if (fit !== undefined) setCount(Math.min(max, Math.max(min, fit)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pageScrollElement);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, pageScrollElement, min, max, fallback]);

  return count;
}
