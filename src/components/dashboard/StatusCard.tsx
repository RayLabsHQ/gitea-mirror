import { cn } from "@/lib/utils";

interface StatusCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  description?: string;
  className?: string;
}

export function StatusCard({
  title,
  value,
  icon,
  description,
  className,
}: StatusCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border border-border bg-card p-5",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {title}
        </span>
        <span className="text-muted-foreground/60">{icon}</span>
      </div>
      <div className="text-2xl font-semibold leading-none">{value}</div>
      {description && (
        <p className="text-xs text-muted-foreground/80">{description}</p>
      )}
    </div>
  );
}
