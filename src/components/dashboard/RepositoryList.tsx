import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GitFork } from "lucide-react";
import { SiGithub, SiGitea } from "react-icons/si";
import type { Repository } from "@/lib/db/schema";
import { getStatusColor } from "@/lib/utils";
import { buildGiteaWebUrl } from "@/lib/gitea-url";
import { useGiteaConfig } from "@/hooks/useGiteaConfig";
import { withBase } from "@/lib/base-path";

interface RepositoryListProps {
  repositories: Repository[];
}

export function RepositoryList({ repositories }: RepositoryListProps) {
  const { giteaConfig } = useGiteaConfig();

  // Helper function to construct Gitea repository URL
  const getGiteaRepoUrl = (repository: Repository): string | null => {
    // Only provide Gitea links for repositories that have been or are being mirrored
    const validStatuses = ['mirroring', 'mirrored', 'syncing', 'synced'];
    if (!validStatuses.includes(repository.status)) {
      return null;
    }

    // Use mirroredLocation if available, otherwise construct from repository data
    let repoPath: string;
    if (repository.mirroredLocation) {
      repoPath = repository.mirroredLocation;
    } else {
      // Fallback: construct the path based on repository data
      // If repository has organization and preserveOrgStructure would be true, use org
      // Otherwise use the repository owner
      const owner = repository.organization || repository.owner;
      repoPath = `${owner}/${repository.name}`;
    }

    return buildGiteaWebUrl(giteaConfig, repoPath);
  };

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Repositories</CardTitle>
        <Button variant="outline" asChild>
          <a href={withBase("/repositories")}>View All</a>
        </Button>
      </CardHeader>
      <CardContent>
        {repositories.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <GitFork className="h-10 w-10 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No repositories found</h3>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Configure your GitHub connection to start mirroring repositories.
            </p>
            <Button asChild>
              <a href={withBase("/config")}>Configure GitHub</a>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {repositories.map((repo, index) => (
              <div
                key={index}
                className="flex items-center gap-x-3 py-3.5"
              >
                <div className="relative flex-shrink-0">
                  <div
                    className={`h-2 w-2 rounded-full ${getStatusColor(
                      repo.status
                    )}`}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="text-sm font-medium truncate">{repo.name}</h4>
                    {repo.isPrivate && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
                        Private
                      </span>
                    )}
                    {repo.isForked && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
                        Fork
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                    <span className="truncate">{repo.owner}</span>
                    {repo.organization && (
                      <>
                        <span>/</span>
                        <span className="truncate">{repo.organization}</span>
                      </>
                    )}
                  </div>
                </div>

                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-medium mr-2
                  ${repo.status === 'imported' ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400' :
                    repo.status === 'mirrored' || repo.status === 'synced' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
                    repo.status === 'mirroring' || repo.status === 'syncing' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' :
                    repo.status === 'failed' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
                    'bg-muted text-muted-foreground'}`}>
                  {repo.status}
                </span>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {(() => {
                    const giteaUrl = getGiteaRepoUrl(repo);
                    const giteaEnabled = giteaUrl && ['mirrored', 'synced'].includes(repo.status);

                    return giteaEnabled ? (
                      <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                        <a
                          href={giteaUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View on Gitea"
                        >
                          <SiGitea className="h-4 w-4" />
                        </a>
                      </Button>
                    ) : (
                      <Button variant="ghost" size="icon" className="h-8 w-8" disabled title="Not mirrored yet">
                        <SiGitea className="h-4 w-4" />
                      </Button>
                    );
                  })()}
                  <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                    <a
                      href={repo.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="View on GitHub"
                    >
                      <SiGithub className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
