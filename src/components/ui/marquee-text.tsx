import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

const MarqueeHoverContext = createContext<boolean | null>(null);

/**
 * Shared hover target: every MarqueeText inside starts scrolling when the
 * pointer is anywhere over this element, so the hit area isn't limited to
 * the text itself.
 */
export function MarqueeTrigger({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const [hovering, setHovering] = useState(false);
  return (
    <div
      {...props}
      className={className}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <MarqueeHoverContext.Provider value={hovering}>
        {children}
      </MarqueeHoverContext.Provider>
    </div>
  );
}

interface MarqueeTextProps {
  children: React.ReactNode;
  className?: string;
  /** Scroll speed in px/s while hovered */
  speed?: number;
}

/**
 * Single-line text that truncates with an ellipsis and scrolls the hidden
 * portion into view on hover (sliding back on mouse leave). The scroll is a
 * compositor-driven transform for smoothness; the content stays plain inline
 * text while at rest because native ellipsis rendering doesn't work on the
 * inline-block wrapper the transform needs.
 */
export function MarqueeText({ children, className, speed = 60 }: MarqueeTextProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const groupHovering = useContext(MarqueeHoverContext);
  const [selfHovering, setSelfHovering] = useState(false);
  const hovering = groupHovering ?? selfHovering;

  const [shift, setShift] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  const [resting, setResting] = useState(true);

  useEffect(() => {
    if (hovering) {
      const container = containerRef.current;
      if (!container) return;
      // Measured on every hover so virtualized rows and resizes stay accurate
      const overflow = Math.max(0, container.scrollWidth - container.clientWidth);
      if (overflow === 0) return;
      setShift(overflow);
      setResting(false);
      // Start the transform a frame after the inline-block swap commits so
      // the transition animates instead of jumping to the end position
      const raf = requestAnimationFrame(() =>
        requestAnimationFrame(() => setScrolling(true))
      );
      return () => cancelAnimationFrame(raf);
    }

    setScrolling(false);
    // Still resting (first render, or the text fits): nothing to undo. Reading
    // the computed transform forces a style recalc, and a virtualized list
    // mounts rows on every scroll.
    if (resting) return;
    // If the text never actually moved (left before the start delay ended),
    // no transition runs and no transitionend will fire — rest immediately
    const content = contentRef.current;
    const transform = content ? getComputedStyle(content).transform : "none";
    if (transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)") {
      setResting(true);
    }
  }, [hovering]);

  return (
    <div
      ref={containerRef}
      onMouseEnter={groupHovering === null ? () => setSelfHovering(true) : undefined}
      onMouseLeave={groupHovering === null ? () => setSelfHovering(false) : undefined}
      className={cn("min-w-0 overflow-hidden whitespace-nowrap", className)}
      style={{ textOverflow: resting ? "ellipsis" : "clip" }}
    >
      <span
        ref={contentRef}
        onTransitionEnd={(e) => {
          if (e.propertyName === "transform" && !scrolling) setResting(true);
        }}
        style={
          resting
            ? undefined
            : {
                display: "inline-block",
                willChange: "transform",
                transform: scrolling ? `translateX(-${shift}px)` : "translateX(0)",
                transition: scrolling
                  ? `transform ${shift / speed}s linear 0.3s`
                  : "transform 0.3s ease-out",
              }
        }
      >
        {children}
      </span>
    </div>
  );
}
