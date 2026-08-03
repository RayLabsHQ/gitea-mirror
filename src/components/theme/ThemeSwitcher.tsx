import * as React from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ThemePreference = "light" | "dark" | "system";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function resolveIsDark(preference: ThemePreference): boolean {
  if (preference === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return preference === "dark";
}

/** Icon-only segmented theme control for the sidebar. Persists the raw
 *  preference (including "system") so it survives reloads. */
export function ThemeSwitcher({ className }: { className?: string }) {
  const [preference, setPreference] = React.useState<ThemePreference>("system");

  React.useEffect(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark" || stored === "system") {
      setPreference(stored);
    }
  }, []);

  React.useEffect(() => {
    document.documentElement.classList[
      resolveIsDark(preference) ? "add" : "remove"
    ]("dark");

    if (preference !== "system") return;
    // Follow OS changes live while "system" is selected.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () =>
      document.documentElement.classList[media.matches ? "add" : "remove"]("dark");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const select = (value: ThemePreference) => {
    setPreference(value);
    localStorage.setItem("theme", value);
  };

  return (
    <div
      className={cn("flex gap-0.5 rounded-lg bg-muted p-0.5", className)}
      role="radiogroup"
      aria-label="Theme"
    >
      <TooltipProvider>
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const active = preference === option.value;
          return (
            <Tooltip key={option.value} delayDuration={300}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={option.label}
                  onClick={() => select(option.value)}
                  className={cn(
                    "flex h-6.5 w-7.5 items-center justify-center rounded-md transition-colors",
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{option.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </TooltipProvider>
    </div>
  );
}
