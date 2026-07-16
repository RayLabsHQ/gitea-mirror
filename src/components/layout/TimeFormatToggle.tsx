import { Clock, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import type { TimeFormatPreference } from "@/lib/utils/time-format";

const OPTIONS: { value: TimeFormatPreference; label: string }[] = [
  { value: "auto", label: "Auto (browser locale)" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
];

export function TimeFormatToggle() {
  const { preference, setPreference } = useTimeFormat();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="lg"
          className="has-[>svg]:px-3"
          title="Time format"
        >
          <Clock className="h-[1.2rem] w-[1.2rem]" />
          <span className="sr-only">Toggle time format</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => setPreference(option.value)}
          >
            <Check
              className={`h-4 w-4 ${
                preference === option.value ? "opacity-100" : "opacity-0"
              }`}
            />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
