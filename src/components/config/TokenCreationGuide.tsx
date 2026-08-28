import { ExternalLink, KeyRound } from "lucide-react";

interface TokenCreationGuideProps {
  settingsUrl?: string;
  settingsTitle?: string;
  steps: string[];
  scopes: string[];
}

export function TokenCreationGuide({
  settingsUrl,
  settingsTitle = "Open token settings",
  steps,
  scopes,
}: TokenCreationGuideProps) {
  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <span className="text-[13px] font-semibold text-muted-foreground">
            Creating your token
          </span>
        </div>
        {settingsUrl && (
          <a
            href={settingsUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={settingsTitle}
            aria-label={settingsTitle}
            className="text-indigo-500 hover:text-indigo-400"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>
      <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {scopes.map((scope) => (
          <code
            key={scope}
            className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {scope}
          </code>
        ))}
      </div>
    </div>
  );
}
