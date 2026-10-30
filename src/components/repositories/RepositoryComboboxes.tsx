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

type ComboboxProps = {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
};

/** These stay comboboxes rather than Selects because the owner and
 *  organization lists grow with the number of mirrored repositories and need
 *  the search box. The trigger borrows the Select styling so it still reads as
 *  the same control as the status and sort dropdowns beside it. */
function FilterCombobox({
  options,
  value,
  onChange,
  emptyLabel,
  searchPlaceholder,
  emptyMessage,
  className,
}: ComboboxProps & {
  emptyLabel: string;
  searchPlaceholder: string;
  emptyMessage: string;
}) {
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
          className={cn(selectTriggerClassName, "h-10 w-full lg:w-50", className)}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || emptyLabel}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-50 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
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
                {emptyLabel}
              </CommandItem>
              {options.map((option) => (
                <CommandItem
                  key={option}
                  value={option}
                  onSelect={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === option ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {option}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function OwnerCombobox(props: ComboboxProps) {
  return (
    <FilterCombobox
      {...props}
      emptyLabel="All owners"
      searchPlaceholder="Search owners..."
      emptyMessage="No owners found."
    />
  );
}

export function OrganizationCombobox(props: ComboboxProps) {
  return (
    <FilterCombobox
      {...props}
      emptyLabel="All organizations"
      searchPlaceholder="Search organizations..."
      emptyMessage="No organizations found."
    />
  );
}

export function DestinationCombobox(props: ComboboxProps) {
  return (
    <FilterCombobox
      {...props}
      emptyLabel="All destinations"
      searchPlaceholder="Search destinations..."
      emptyMessage="No destinations found."
    />
  );
}
