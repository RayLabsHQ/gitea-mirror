import type { MembershipRole } from "./organizations";
import type { ActivityStatus } from "./Repository";

export interface FilterParams {
  searchTerm?: string;
  status?: ActivityStatus | ""; // repos, activity   and orgs status
  membershipRole?: MembershipRole | ""; //membership role in orgs
  owner?: string; // owner of the repos
  organization?: string; // organization of the repos
  sort?: string; // repository sort order
  hasOverrides?: "overridden" | "default" | ""; // repos with custom mirror options
  type?: string; //types in activity log
  name?: string; // name in activity log
}
