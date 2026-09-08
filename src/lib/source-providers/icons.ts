import type { ComponentType } from "react";
import { SiGitea, SiGithub, SiGitlab } from "react-icons/si";

import type { SourceProviderKind } from "./kinds";

export const SOURCE_PROVIDER_ICONS: Record<
  SourceProviderKind,
  ComponentType<{ className?: string }>
> = {
  github: SiGithub,
  gitlab: SiGitlab,
  gitea: SiGitea,
};
