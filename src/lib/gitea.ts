import {
  repoStatusEnum,
  type RepositoryVisibility,
  type RepoStatus,
} from "@/types/Repository";
import { Octokit } from "@octokit/rest";
import type { Config } from "@/types/config";
import type { Organization, Repository } from "./db/schema";
import superagent from "superagent";
import { createMirrorJob } from "./helpers";
import { db, organizations, repositories } from "./db";
import { eq } from "drizzle-orm";
import PQueue from "p-queue";

export const getGiteaRepoOwner = ({
  config,
  repository,
}: {
  config: Partial<Config>;
  repository: Repository;
}): string => {
  if (!config.githubConfig || !config.giteaConfig) {
    throw new Error("GitHub or Gitea config is required.");
  }

  if (!config.giteaConfig.username) {
    throw new Error("Gitea username is required.");
  }

  // if the config has preserveOrgStructure set to true, then use the org name as the owner
  if (config.githubConfig.preserveOrgStructure && repository.organization) {
    return repository.organization;
  }

  // if the config has preserveOrgStructure set to false, then use the gitea username as the owner
  return config.giteaConfig.username;
};

export const isRepoPresentInGitea = async ({
  config,
  owner,
  repoName,
}: {
  config: Partial<Config>;
  owner: string;
  repoName: string;
}): Promise<boolean> => {
  try {
    if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
      throw new Error("Gitea config is required.");
    }

    // Check if the repository exists at the specified owner location
    const response = await fetch(
      `${config.giteaConfig.url}/api/v1/repos/${owner}/${repoName}`,
      {
        headers: {
          Authorization: `token ${config.giteaConfig.token}`,
        },
      }
    );

    return response.ok;
  } catch (error) {
    console.error("Error checking if repo exists in Gitea:", error);
    return false;
  }
};

/**
 * Helper function to check if a repository exists in Gitea.
 * First checks the recorded mirroredLocation, then falls back to the expected location.
 */
export const checkRepoLocation = async ({
  config,
  repository,
  expectedOwner,
}: {
  config: Partial<Config>;
  repository: Repository;
  expectedOwner: string;
}): Promise<{ present: boolean; actualOwner: string }> => {
  // First check if we have a recorded mirroredLocation and if the repo exists there
  if (repository.mirroredLocation && repository.mirroredLocation.trim() !== "") {
    const [mirroredOwner] = repository.mirroredLocation.split('/');
    if (mirroredOwner) {
      const mirroredPresent = await isRepoPresentInGitea({
        config,
        owner: mirroredOwner,
        repoName: repository.name,
      });

      if (mirroredPresent) {
        console.log(`Repository found at recorded mirrored location: ${repository.mirroredLocation}`);
        return { present: true, actualOwner: mirroredOwner };
      }
    }
  }

  // If not found at the recorded location, check the expected location
  const present = await isRepoPresentInGitea({
    config,
    owner: expectedOwner,
    repoName: repository.name,
  });

  if (present) {
    return { present: true, actualOwner: expectedOwner };
  }

  // Repository not found at any location
  return { present: false, actualOwner: expectedOwner };
};

export const mirrorGithubRepoToGitea = async ({
  octokit,
  repository,
  config,
}: {
  octokit: Octokit;
  repository: Repository;
  config: Partial<Config>;
}): Promise<any> => {
  try {
    if (!config.userId || !config.githubConfig || !config.giteaConfig) {
      throw new Error("github config and gitea config are required.");
    }

    if (!config.giteaConfig.username) {
      throw new Error("Gitea username is required.");
    }

    const isExisting = await isRepoPresentInGitea({
      config,
      owner: config.giteaConfig.username,
      repoName: repository.name,
    });

    if (isExisting) {
      console.log(
        `Repository ${repository.name} already exists in Gitea. Skipping migration.`
      );
      return;
    }

    console.log(`Mirroring repository ${repository.name}`);

    // Mark repos as "mirroring" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirroring"),
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "mirroring" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Started mirroring repository: ${repository.name}`,
      details: `Repository ${repository.name} is now in the mirroring state.`,
      status: "mirroring",
    });

    let cloneAddress = repository.cloneUrl;

    // If the repository is private, inject the GitHub token into the clone URL
    if (repository.isPrivate) {
      if (!config.githubConfig.token) {
        throw new Error(
          "GitHub token is required to mirror private repositories."
        );
      }

      cloneAddress = repository.cloneUrl.replace(
        "https://",
        `https://${config.githubConfig.token}@`
      );
    }

    const apiUrl = `${config.giteaConfig.url}/api/v1/repos/migrate`;

    const response = await superagent
      .post(apiUrl)
      .set("Authorization", `token ${config.giteaConfig.token}`)
      .set("Content-Type", "application/json")
      .send({
        clone_addr: cloneAddress,
        repo_name: repository.name,
        mirror: true,
        private: repository.isPrivate,
        repo_owner: config.giteaConfig.username,
        description: "",
        service: "git",
      });

    // clone issues
    if (config.githubConfig.mirrorIssues) {
      await mirrorGitRepoIssuesToGitea({
        config,
        octokit,
        repository,
        isRepoInOrg: false,
      });
    }

    console.log(`Repository ${repository.name} mirrored successfully`);

    // Mark repos as "mirrored" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirrored"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
        mirroredLocation: `${config.giteaConfig.username}/${repository.name}`,
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "mirrored" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Successfully mirrored repository: ${repository.name}`,
      details: `Repository ${repository.name} was mirrored to Gitea.`,
      status: "mirrored",
    });

    return response.body;
  } catch (error) {
    console.error(
      `Error while mirroring repository ${repository.name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    // Mark repos as "failed" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for failure
    await createMirrorJob({
      userId: config.userId ?? "", // userId is going to be there anyways
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Failed to mirror repository: ${repository.name}`,
      details: `Repository ${repository.name} failed to mirror. Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      status: "failed",
    });
    if (error instanceof Error) {
      throw new Error(`Failed to mirror repository: ${error.message}`);
    }
    throw new Error("Failed to mirror repository: An unknown error occurred.");
  }
};

export async function getOrCreateGiteaOrg({
  orgName,
  orgId,
  config,
}: {
  orgId?: string; //db id
  orgName: string;
  config: Partial<Config>;
}): Promise<number> {
  if (
    !config.giteaConfig?.url ||
    !config.giteaConfig?.token ||
    !config.userId
  ) {
    throw new Error("Gitea config is required.");
  }

  try {
    const orgRes = await fetch(
      `${config.giteaConfig.url}/api/v1/orgs/${orgName}`,
      {
        headers: {
          Authorization: `token ${config.giteaConfig.token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (orgRes.ok) {
      const org = await orgRes.json();

      await createMirrorJob({
        userId: config.userId,
        organizationId: org.id,
        organizationName: orgName,
        status: "imported",
        message: `Organization ${orgName} fetched successfully`,
        details: `Organization ${orgName} was fetched from GitHub`,
      });
      return org.id;
    }

    const createRes = await fetch(`${config.giteaConfig.url}/api/v1/orgs`, {
      method: "POST",
      headers: {
        Authorization: `token ${config.giteaConfig.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: orgName,
        full_name: `${orgName} Org`,
        description: `Mirrored organization from GitHub ${orgName}`,
        visibility: "public",
      }),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create Gitea org: ${await createRes.text()}`);
    }

    await createMirrorJob({
      userId: config.userId,
      organizationName: orgName,
      status: "imported",
      message: `Organization ${orgName} created successfully`,
      details: `Organization ${orgName} was created in Gitea`,
    });

    const newOrg = await createRes.json();
    return newOrg.id;
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unknown error occurred in getOrCreateGiteaOrg.";

    await createMirrorJob({
      userId: config.userId,
      organizationId: orgId,
      organizationName: orgName,
      message: `Failed to create or fetch Gitea organization: ${orgName}`,
      status: "failed",
      details: `Error: ${errorMessage}`,
    });

    throw new Error(`Error in getOrCreateGiteaOrg: ${errorMessage}`);
  }
}

export async function mirrorGitHubRepoToGiteaOrg({
  octokit,
  config,
  repository,
  giteaOrgId,
  orgName,
}: {
  octokit: Octokit;
  config: Partial<Config>;
  repository: Repository;
  giteaOrgId: number;
  orgName: string;
}) {
  try {
    if (
      !config.giteaConfig?.url ||
      !config.giteaConfig?.token ||
      !config.userId
    ) {
      throw new Error("Gitea config is required.");
    }

    const isExisting = await isRepoPresentInGitea({
      config,
      owner: orgName,
      repoName: repository.name,
    });

    if (isExisting) {
      console.log(
        `Repository ${repository.name} already exists in Gitea. Skipping migration.`
      );
      return;
    }

    console.log(
      `Mirroring repository ${repository.name} to organization ${orgName}`
    );

    let cloneAddress = repository.cloneUrl;

    if (repository.isPrivate) {
      if (!config.githubConfig?.token) {
        throw new Error(
          "GitHub token is required to mirror private repositories."
        );
      }

      cloneAddress = repository.cloneUrl.replace(
        "https://",
        `https://${config.githubConfig.token}@`
      );
    }

    // Mark repos as "mirroring" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirroring"),
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "mirroring" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Started mirroring repository: ${repository.name}`,
      details: `Repository ${repository.name} is now in the mirroring state.`,
      status: "mirroring",
    });

    const apiUrl = `${config.giteaConfig.url}/api/v1/repos/migrate`;

    const migrateRes = await superagent
      .post(apiUrl)
      .set("Authorization", `token ${config.giteaConfig.token}`)
      .set("Content-Type", "application/json")
      .send({
        clone_addr: cloneAddress,
        uid: giteaOrgId,
        repo_name: repository.name,
        mirror: true,
        private: repository.isPrivate,
      });

    // Clone issues
    if (config.githubConfig?.mirrorIssues) {
      await mirrorGitRepoIssuesToGitea({
        config,
        octokit,
        repository,
        isRepoInOrg: true,
      });
    }

    console.log(
      `Repository ${repository.name} mirrored successfully to organization ${orgName}`
    );

    // Mark repos as "mirrored" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("mirrored"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
        mirroredLocation: `${orgName}/${repository.name}`,
      })
      .where(eq(repositories.id, repository.id!));

    //create a mirror job
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Repository ${repository.name} mirrored successfully`,
      details: `Repository ${repository.name} was mirrored to Gitea`,
      status: "mirrored",
    });

    return migrateRes.body;
  } catch (error) {
    console.error(
      `Error while mirroring repository ${repository.name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    // Mark repos as "failed" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for failure
    await createMirrorJob({
      userId: config.userId || "", // userId is going to be there anyways
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Failed to mirror repository: ${repository.name}`,
      details: `Repository ${repository.name} failed to mirror. Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      status: "failed",
    });
    if (error instanceof Error) {
      throw new Error(`Failed to mirror repository: ${error.message}`);
    }
    throw new Error("Failed to mirror repository: An unknown error occurred.");
  }
}

export async function mirrorGitHubOrgRepoToGiteaOrg({
  config,
  octokit,
  repository,
  orgName,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  orgName: string;
}) {
  try {
    if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
      throw new Error("Gitea config is required.");
    }

    const giteaOrgId = await getOrCreateGiteaOrg({
      orgName,
      config,
    });

    await mirrorGitHubRepoToGiteaOrg({
      octokit,
      config,
      repository,
      giteaOrgId,
      orgName,
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to mirror repository: ${error.message}`);
    }
    throw new Error("Failed to mirror repository: An unknown error occurred.");
  }
}

export async function mirrorGitHubOrgToGitea({
  organization,
  octokit,
  config,
}: {
  organization: Organization;
  octokit: Octokit;
  config: Partial<Config>;
}) {
  try {
    if (
      !config.userId ||
      !config.id ||
      !config.githubConfig?.token ||
      !config.giteaConfig?.url
    ) {
      throw new Error("Config, GitHub token and Gitea URL are required.");
    }

    console.log(`Mirroring organization ${organization.name}`);

    //mark the org as "mirroring" in DB
    await db
      .update(organizations)
      .set({
        isIncluded: true,
        status: repoStatusEnum.parse("mirroring"),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, organization.id!));

    // Append log for "mirroring" status
    await createMirrorJob({
      userId: config.userId,
      organizationId: organization.id,
      organizationName: organization.name,
      message: `Started mirroring organization: ${organization.name}`,
      details: `Organization ${organization.name} is now in the mirroring state.`,
      status: repoStatusEnum.parse("mirroring"),
    });

    const giteaOrgId = await getOrCreateGiteaOrg({
      orgId: organization.id,
      orgName: organization.name,
      config,
    });

    //query the db with the org name and get the repos
    const orgRepos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.organization, organization.name));

    const queue = new PQueue({ concurrency: 3 });

    for (const repo of orgRepos) {
      queue.add(async () => {
        try {
          await mirrorGitHubRepoToGiteaOrg({
            octokit,
            config,
            repository: {
              ...repo,
              status: repo.status as RepoStatus,
              visibility: repo.visibility as RepositoryVisibility,
              lastMirrored: repo.lastMirrored ?? undefined,
              errorMessage: repo.errorMessage ?? undefined,
              organization: repo.organization ?? undefined,
              forkedFrom: repo.forkedFrom ?? undefined,
              mirroredLocation: repo.mirroredLocation || "",
            },
            giteaOrgId,
            orgName: organization.name,
          });
        } catch (err) {
          console.error(`Failed to mirror repo ${repo.name}:`, err);
        }
      });
    }

    await queue.onIdle();

    console.log(`Organization ${organization.name} mirrored successfully`);

    // Mark org as "mirrored" in DB
    await db
      .update(organizations)
      .set({
        status: repoStatusEnum.parse("mirrored"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
      })
      .where(eq(organizations.id, organization.id!));

    // Append log for "mirrored" status
    await createMirrorJob({
      userId: config.userId,
      organizationId: organization.id,
      organizationName: organization.name,
      message: `Successfully mirrored organization: ${organization.name}`,
      details: `Organization ${organization.name} was mirrored to Gitea.`,
      status: repoStatusEnum.parse("mirrored"),
    });
  } catch (error) {
    console.error(
      `Error while mirroring organization ${organization.name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    // Mark org as "failed" in DB
    await db
      .update(organizations)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      })
      .where(eq(organizations.id, organization.id!));

    // Append log for failure
    await createMirrorJob({
      userId: config.userId || "", // userId is going to be there anyways
      organizationId: organization.id,
      organizationName: organization.name,
      message: `Failed to mirror organization: ${organization.name}`,
      details: `Organization ${organization.name} failed to mirror. Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      status: repoStatusEnum.parse("failed"),
    });

    if (error instanceof Error) {
      throw new Error(`Failed to mirror repository: ${error.message}`);
    }
    throw new Error("Failed to mirror repository: An unknown error occurred.");
  }
}

export const syncGiteaRepo = async ({
  config,
  repository,
}: {
  config: Partial<Config>;
  repository: Repository;
}) => {
  try {
    if (
      !config.userId ||
      !config.giteaConfig?.url ||
      !config.giteaConfig?.token ||
      !config.giteaConfig?.username
    ) {
      throw new Error("Gitea config is required.");
    }

    console.log(`Syncing repository ${repository.name}`);

    // Mark repo as "syncing" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("syncing"),
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "syncing" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Started syncing repository: ${repository.name}`,
      details: `Repository ${repository.name} is now in the syncing state.`,
      status: repoStatusEnum.parse("syncing"),
    });

    // Get the expected owner based on current config
    const repoOwner = getGiteaRepoOwner({ config, repository });

    // Check if repo exists at the expected location or alternate location
    const { present, actualOwner } = await checkRepoLocation({
      config,
      repository,
      expectedOwner: repoOwner
    });

    if (!present) {
      throw new Error(`Repository ${repository.name} not found in Gitea at any expected location`);
    }

    // Use the actual owner where the repo was found
    const apiUrl = `${config.giteaConfig.url}/api/v1/repos/${actualOwner}/${repository.name}/mirror-sync`;

    const response = await superagent
      .post(apiUrl)
      .set("Authorization", `token ${config.giteaConfig.token}`);

    // Mark repo as "synced" in DB
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("synced"),
        updatedAt: new Date(),
        lastMirrored: new Date(),
        errorMessage: null,
        mirroredLocation: `${actualOwner}/${repository.name}`,
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "synced" status
    await createMirrorJob({
      userId: config.userId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      message: `Successfully synced repository: ${repository.name}`,
      details: `Repository ${repository.name} was synced with Gitea.`,
      status: repoStatusEnum.parse("synced"),
    });

    console.log(`Repository ${repository.name} synced successfully`);

    return response.body;
  } catch (error) {
    console.error(
      `Error while syncing repository ${repository.name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    // Optional: update repo with error status
    await db
      .update(repositories)
      .set({
        status: repoStatusEnum.parse("failed"),
        updatedAt: new Date(),
        errorMessage: (error as Error).message,
      })
      .where(eq(repositories.id, repository.id!));

    // Append log for "error" status
    if (config.userId && repository.id && repository.name) {
      await createMirrorJob({
        userId: config.userId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        message: `Failed to sync repository: ${repository.name}`,
        details: (error as Error).message,
        status: repoStatusEnum.parse("failed"),
      });
    }

    if (error instanceof Error) {
      throw new Error(`Failed to sync repository: ${error.message}`);
    }
    throw new Error("Failed to sync repository: An unknown error occurred.");
  }
};

export const mirrorGitRepoIssuesToGitea = async ({
  config,
  octokit,
  repository,
  isRepoInOrg,
}: {
  config: Partial<Config>;
  octokit: Octokit;
  repository: Repository;
  isRepoInOrg: boolean;
}) => {
  //things covered here are- issue, title, body, labels, comments and assignees
  if (
    !config.githubConfig?.token ||
    !config.giteaConfig?.token ||
    !config.giteaConfig?.url ||
    !config.giteaConfig?.username
  ) {
    throw new Error("Missing GitHub or Gitea configuration.");
  }

  const repoOrigin = isRepoInOrg
    ? repository.organization
    : config.githubConfig.username;

  const [owner, repo] = repository.fullName.split("/");

  // Fetch GitHub issues
  const issues = await octokit.paginate(
    octokit.rest.issues.listForRepo,
    {
      owner,
      repo,
      state: "all",
      per_page: 100,
    },
    (res) => res.data
  );

  console.log(`Mirroring ${issues.length} issues from ${repository.fullName}`);

  // Get existing labels from Gitea
  const giteaLabelsRes = await superagent
    .get(
      `${config.giteaConfig.url}/api/v1/repos/${repoOrigin}/${repository.name}/labels`
    )
    .set("Authorization", `token ${config.giteaConfig.token}`);

  const giteaLabels = giteaLabelsRes.body;
  const labelMap = new Map<string, number>(
    giteaLabels.map((label: any) => [label.name, label.id])
  );

  for (const issue of issues) {
    if ((issue as any).pull_request) {
      continue;
    }

    const githubLabelNames =
      issue.labels
        ?.map((l) => (typeof l === "string" ? l : l.name))
        .filter((l): l is string => !!l) || [];

    const giteaLabelIds: number[] = [];

    // Resolve or create labels in Gitea
    for (const name of githubLabelNames) {
      if (labelMap.has(name)) {
        giteaLabelIds.push(labelMap.get(name)!);
      } else {
        try {
          const created = await superagent
            .post(
              `${config.giteaConfig.url}/api/v1/repos/${repoOrigin}/${repository.name}/labels`
            )
            .set("Authorization", `token ${config.giteaConfig.token}`)
            .send({ name, color: "#ededed" }); // Default color

          labelMap.set(name, created.body.id);
          giteaLabelIds.push(created.body.id);
        } catch (labelErr) {
          console.error(
            `Failed to create label "${name}" in Gitea: ${labelErr}`
          );
        }
      }
    }

    const originalAssignees =
      issue.assignees && issue.assignees.length > 0
        ? `\n\nOriginally assigned to: ${issue.assignees
            .map((a) => `@${a.login}`)
            .join(", ")} on GitHub.`
        : "";

    const issuePayload: any = {
      title: issue.title,
      body: `Originally created by @${
        issue.user?.login
      } on GitHub.${originalAssignees}\n\n${issue.body || ""}`,
      closed: issue.state === "closed",
      labels: giteaLabelIds,
    };

    try {
      const createdIssue = await superagent
        .post(
          `${config.giteaConfig.url}/api/v1/repos/${repoOrigin}/${repository.name}/issues`
        )
        .set("Authorization", `token ${config.giteaConfig.token}`)
        .send(issuePayload);

      // Clone comments
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        {
          owner,
          repo,
          issue_number: issue.number,
          per_page: 100,
        },
        (res) => res.data
      );

      for (const comment of comments) {
        try {
          await superagent
            .post(
              `${config.giteaConfig.url}/api/v1/repos/${repoOrigin}/${repository.name}/issues/${createdIssue.body.number}/comments`
            )
            .set("Authorization", `token ${config.giteaConfig.token}`)
            .send({
              body: `@${comment.user?.login} commented on GitHub:\n\n${comment.body}`,
            });
        } catch (commentErr) {
          console.error(
            `Failed to copy comment to Gitea for issue "${issue.title}": ${
              commentErr instanceof Error
                ? commentErr.message
                : String(commentErr)
            }`
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && (err as any).response) {
        console.error(
          `Failed to create issue "${issue.title}" in Gitea: ${err.message}`
        );
        console.error(
          `Response body: ${JSON.stringify((err as any).response.body)}`
        );
      } else {
        console.error(
          `Failed to create issue "${issue.title}" in Gitea: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }
};
