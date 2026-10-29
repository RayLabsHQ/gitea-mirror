import {
  LayoutDashboard,
  GitFork,
  Settings,
  Activity,
  Building2,
  HardDrive,
} from "lucide-react";
import type { SidebarItem } from "@/types/Sidebar";

export const links: SidebarItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/repositories", label: "Repositories", icon: GitFork },
  { href: "/organizations", label: "Organizations", icon: Building2 },
  { href: "/storage", label: "Storage", icon: HardDrive },
  { href: "/config", label: "Configuration", icon: Settings },
  { href: "/activity", label: "Activity Log", icon: Activity },
];
