import * as React from "react";
import { Clock, CircleCheck, Globe } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import type { TimeFormatPreference } from "@/lib/utils/time-format";

function formatNow(now: Date, preference: TimeFormatPreference): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  if (preference === "12h") options.hour12 = true;
  if (preference === "24h") options.hour12 = false;
  return new Intl.DateTimeFormat(undefined, options).format(now);
}

export function TimeFormatToggle() {
  const { preference, setPreference } = useTimeFormat();
  const [now, setNow] = React.useState(() => new Date());
  const locale =
    typeof navigator !== "undefined" ? navigator.language : undefined;

  // Keep the trigger clock fresh.
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const options: {
    value: TimeFormatPreference;
    label: string;
    example: string;
    mono: boolean;
  }[] = [
    {
      value: "auto",
      label: "Auto",
      example: formatNow(now, "auto"),
      mono: true,
    },
    { value: "12h", label: "12-hour", example: formatNow(now, "12h"), mono: true },
    { value: "24h", label: "24-hour", example: formatNow(now, "24h"), mono: true },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="lg"
          className="gap-2 px-3"
          title="Time format"
        >
          <Clock className="h-[1.1rem] w-[1.1rem]" />
          <span className="font-mono text-xs text-muted-foreground">
            {formatNow(now, preference)}
          </span>
          <span className="sr-only">Toggle time format</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-70 p-1.5">
        <DropdownMenuLabel className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Time format
          </span>
          {locale && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-normal text-muted-foreground">
              <Globe className="h-3 w-3" />
              {locale}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((option) => {
          const selected = preference === option.value;
          return (
            <DropdownMenuItem
              key={option.value}
              onClick={() => setPreference(option.value)}
              className={cn(
                "gap-2.5 rounded-lg px-2.5 py-2.5",
                selected && "bg-muted/60"
              )}
            >
              <div className="flex flex-1 items-center gap-2">
                {option.value === "auto" && (
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    "text-[13px] leading-none",
                    selected && "font-semibold"
                  )}
                >
                  {option.label}
                </span>
              </div>
              <span
                className={cn(
                  "text-xs text-muted-foreground",
                  option.mono && "font-mono"
                )}
              >
                {option.example}
              </span>
              <CircleCheck
                className={cn(
                  "h-4 w-4 text-indigo-500",
                  selected ? "opacity-100" : "opacity-0"
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
