import * as React from "react";

export type Paths =
  | "/"
  | "/repositories"
  | "/organizations"
  | "/storage"
  | "/config"
  | "/activity";

export interface SidebarItem {
  href: Paths;
  label: string;
  icon: React.ElementType;
}
