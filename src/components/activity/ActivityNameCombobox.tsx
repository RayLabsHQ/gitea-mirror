import * as React from "react";
import { ChevronDown, Check } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { selectTriggerClassName } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { compareNames } from "@/lib/utils/compare-names";

type ActivityNameComboboxProps = {
  activities: any[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

/** Stays a combobox rather than a Select because the name list grows with the
 *  activity log and needs the search box. The trigger borrows the Select
 *  styling so it reads as the same control as the status and type dropdowns. */
export function ActivityNameCombobox({
  activities,
  value,
  onChange,
  className,
}: ActivityNameComboboxProps) {
  // Collect unique names from repositoryName and organizationName
  const names = React.useMemo(() => {
    const set = new Set<string>();
    activities.forEach((a) => {
      if (a.repositoryName) set.add(a.repositoryName);
      if (a.organizationName) set.add(a.organizationName);
    });
    return Array.from(set).sort(compareNames);
  }, [activities]);

  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The button stays inline: PopoverTrigger asChild clones its child to
          attach the click handler and ref, which a wrapper component would
          swallow unless it forwarded both. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            selectTriggerClassName,
            "h-10 w-full lg:w-50",
            className
          )}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || "All names"}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-50 p-0">
        <Command>
          <CommandInput placeholder="Search name..." />
          <CommandList>
            <CommandEmpty>No name found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                key="all"
                value=""
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === "" ? "opacity-100" : "opacity-0"
                  )}
                />
                All names
              </CommandItem>
              {names.map((name) => (
                <CommandItem
                  key={name}
                  value={name}
                  onSelect={() => {
                    onChange(name);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === name ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
