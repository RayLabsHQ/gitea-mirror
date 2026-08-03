import type { ComponentType, ReactNode } from "react";
type IconComponent = ComponentType<{ className?: string }>;
import { CircleCheck, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Indigo accent used across the redesigned settings surfaces. */
export const accentSwitch =
  "data-[state=checked]:bg-indigo-500 dark:data-[state=checked]:bg-indigo-500";

interface SettingsCardProps {
  icon: IconComponent;
  title: string;
  /** Renders a switch in the header; the card is toggled as a whole. */
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  /** Custom element on the right side of the header (e.g. a Test button). */
  headerAction?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function SettingsCard({
  icon: Icon,
  title,
  enabled,
  onEnabledChange,
  headerAction,
  footer,
  className,
  children,
}: SettingsCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-border bg-card overflow-hidden",
        className
      )}
    >
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <Icon className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-base font-semibold">{title}</h3>
        </div>
        <div className="flex items-center gap-3">
          {headerAction}
          {onEnabledChange && (
            <Switch
              checked={enabled}
              onCheckedChange={onEnabledChange}
              className={accentSwitch}
              aria-label={`Enable ${title.toLowerCase()}`}
            />
          )}
        </div>
      </div>
      <div className="border-t border-border" />
      <div className="flex-1 flex flex-col">{children}</div>
      {footer && (
        <>
          <div className="border-t border-border" />
          <div className="flex items-center justify-between gap-4 px-6 py-3.5">
            {footer}
          </div>
        </>
      )}
    </div>
  );
}

export function SectionTitle({
  children,
  badge,
  action,
}: {
  children: ReactNode;
  badge?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {children}
        </span>
        {badge && (
          <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-indigo-500">
            {badge}
          </span>
        )}
      </div>
      {action}
    </div>
  );
}

export function InfoHint({ content }: { content: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help text-muted-foreground/50 hover:text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{content}</TooltipContent>
    </Tooltip>
  );
}

interface OptionRowProps {
  icon?: IconComponent;
  label: string;
  description?: string;
  info?: ReactNode;
  badge?: string;
  /** Control rendered on the right (switch, pill, input...). */
  right?: ReactNode;
  className?: string;
}

export function OptionRow({
  icon: Icon,
  label,
  description,
  info,
  badge,
  right,
  className,
}: OptionRowProps) {
  return (
    <div className={cn("flex items-center gap-4", className)}>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="text-sm font-medium leading-none">{label}</span>
          {badge && (
            <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-indigo-500">
              {badge}
            </span>
          )}
          {info && <InfoHint content={info} />}
        </div>
        {description && (
          <p className="text-[13px] text-muted-foreground">{description}</p>
        )}
      </div>
      {right}
    </div>
  );
}

/** Switch row shorthand used by most option lists. */
export function SwitchRow(
  props: Omit<OptionRowProps, "right"> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    /** Extra element rendered between text and switch (e.g. "Latest 10"). */
    extra?: ReactNode;
  }
) {
  const { checked, onCheckedChange, disabled, extra, ...rest } = props;
  return (
    <OptionRow
      {...rest}
      right={
        <div className="flex items-center gap-3">
          {extra}
          <Switch
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            className={accentSwitch}
            aria-label={rest.label}
          />
        </div>
      }
    />
  );
}

interface OptionTileProps {
  icon: IconComponent;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  info?: ReactNode;
  disabled?: boolean;
}

/** Selection tile ("variant C"): icon chip, label with info, description,
 *  and a check mark only on the selected tile. */
export function OptionTile({
  icon: Icon,
  label,
  description,
  selected,
  onSelect,
  info,
  disabled,
}: OptionTileProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "flex flex-1 items-start gap-3 rounded-lg border p-3.5 text-left transition-colors",
        selected
          ? "border-indigo-500 bg-indigo-500/10"
          : "border-border hover:border-muted-foreground/40",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
          selected
            ? "bg-indigo-500/20 text-indigo-400"
            : "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="flex-1 min-w-0 space-y-1">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "text-[13px] font-medium leading-none",
              selected ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {label}
          </span>
          {info && <InfoHint content={info} />}
        </span>
        <span className="block text-[11px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      {selected && (
        <CircleCheck className="h-4 w-4 shrink-0 text-indigo-500" />
      )}
    </button>
  );
}

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string; icon?: IconComponent }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={cn(
        "flex w-full gap-1 rounded-lg bg-muted p-1",
        className
      )}
      role="tablist"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const OptIcon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs transition-colors",
              active
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {OptIcon && <OptIcon className="h-3 w-3" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function StatusFooterItem({
  icon: Icon,
  label,
  value,
  valueClassName,
}: {
  icon: IconComponent;
  label: string;
  value?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
      {value !== undefined && (
        <span className={cn("font-medium text-muted-foreground", valueClassName)}>
          {value}
        </span>
      )}
    </div>
  );
}

/** Divider between sections inside a SettingsCard. */
export function CardDivider() {
  return <div className="border-t border-border" />;
}

/** Standard padded section body inside a SettingsCard. */
export function CardSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("space-y-4 p-6", className)}>{children}</div>;
}
