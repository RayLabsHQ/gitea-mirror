import { SiGitea, SiGithub, SiGitlab } from "react-icons/si";
import {
  SOURCE_PROVIDER_LABELS,
  getRepositorySource,
  type RepositorySourceFields,
  type SourceProviderKind,
} from "@/lib/source-providers/kinds";

const icons: Record<SourceProviderKind, React.ComponentType<{ className?: string }>> = {
  github: SiGithub,
  gitlab: SiGitlab,
  gitea: SiGitea,
};

/** Brand icon for the host a repository came from. */
export function SourceIcon({
  provider,
  className,
}: {
  provider: SourceProviderKind;
  className?: string;
}) {
  const Icon = icons[provider] ?? SiGithub;
  return <Icon className={className} />;
}

/** Provider kind and label for a stored repository row. */
export function repositorySourceInfo(repo: RepositorySourceFields): {
  provider: SourceProviderKind;
  label: string;
} {
  const { provider } = getRepositorySource(repo);
  return { provider, label: SOURCE_PROVIDER_LABELS[provider] };
}
