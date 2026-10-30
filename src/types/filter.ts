import type { MembershipRole } from "./organizations";
import type { ActivityStatus } from "./Repository";

export interface FilterParams {
  searchTerm?: string;
  status?: ActivityStatus | ""; // repos, activity   and orgs status
  membershipRole?: MembershipRole | ""; //membership role in orgs
  owner?: string; // owner of the repos
  organization?: string; // source organization of the repos
  destinationOrganization?: string; // resolved organization/owner on the destination
  sort?: string; // repository sort order
  hasOverrides?: "overridden" | "default" | ""; // repos with custom mirror options
  type?: string; //types in activity log
  name?: string; // name in activity log
}
