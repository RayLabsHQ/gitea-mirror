import * as React from "react";

export type Paths =
  | "/"
  | "/repositories"
  | "/organizations"
  | "/servers"
  | "/config"
  | "/activity";

export interface SidebarItem {
  href: Paths;
  label: string;
  icon: React.ElementType;
}
