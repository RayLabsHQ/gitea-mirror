import type { MembershipRole } from "./organizations";
import type { RepoStatus } from "./Repository";

export interface FilterParams {
  searchTerm?: string;
  status?: RepoStatus | ""; // repos, activity   and orgs status
  membershipRole?: MembershipRole | ""; //membership role in orgs
  owner?: string; // owner of the repos
  organization?: string; // organization of the repos
  sort?: string; // repository sort order
  type?: string; //types in activity log
  name?: string; // name in activity log
}
