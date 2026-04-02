import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

import { ModeToggle } from "@/components/theme/ModeToggle";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import { useConfigStatus } from "@/hooks/useConfigStatus";
import { Menu, LogOut, PanelRightOpen, PanelRightClose } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { withBase } from "@/lib/base-path";

interface HeaderProps {
  currentPage?: "dashboard" | "repositories" | "organizations" | "configuration" | "activity-log";
  onNavigate?: (page: string) => void;
  onMenuClick: () => void;
  onToggleCollapse?: () => void;
  isSidebarCollapsed?: boolean;
  isSidebarOpen?: boolean;
}

export function Header({ currentPage, onNavigate, onMenuClick, onToggleCollapse, isSidebarCollapsed, isSidebarOpen }: HeaderProps) {
  const { user, logout, isLoading } = useAuth();
  const { isLiveEnabled, toggleLive } = useLiveRefresh();
  const { isFullyConfigured, isLoading: configLoading } = useConfigStatus();

  // Show Live button on all pages except configuration
  const showLiveButton = currentPage && currentPage !== "configuration";

  // Determine button state and tooltip
  const isLiveActive = isLiveEnabled && isFullyConfigured;
  const getTooltip = () => {
    if (configLoading) {
      return 'Loading configuration...';
    }
    if (!isFullyConfigured) {
      return isLiveEnabled
        ? 'Live refresh enabled but requires GitHub and Gitea configuration to function'
        : 'Enable live refresh (requires GitHub and Gitea configuration)';
    }
    return isLiveEnabled ? 'Disable live refresh' : 'Enable live refresh';
  };

  const handleLogout = async () => {
    toast.success("Logged out successfully");
    // Small delay to show the toast before redirecting
    await new Promise((resolve) => setTimeout(resolve, 500));
    logout();
  };

  // Auth buttons skeleton loader
  function AuthButtonsSkeleton() {
    return (
      <>
        <Skeleton className="h-10 w-10 rounded-full" /> {/* Avatar placeholder */}
        <Skeleton className="h-10 w-24" /> {/* Button placeholder */}
      </>
    );
  }

  return (
    <header className="border-b bg-background">
      <div className="flex h-[4.5rem] items-center justify-between px-4 sm:px-6">
        <div className="flex items-center lg:gap-12 md:gap-6 gap-4">
          {/* Sidebar Toggle - Mobile uses slide-in, Medium uses collapse */}
          <Button
            variant="outline"
            size="icon"
            className="md:hidden h-10 w-10"
            onClick={onMenuClick}
          >
            {isSidebarOpen ? (
              <PanelRightOpen className="h-5 w-5" />
            ) : (
              <PanelRightClose className="h-5 w-5" />
            )}
            <span className="sr-only">Toggle menu</span>
          </Button>
          
          {/* Sidebar Collapse Toggle - Only on medium screens (768px - 1280px) */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:flex xl:hidden h-10 w-10"
            onClick={onToggleCollapse}
            title={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isSidebarCollapsed ? (
              <PanelRightClose className="h-5 w-5" />
            ) : (
              <PanelRightOpen className="h-5 w-5" />
            )}
            <span className="sr-only">Toggle sidebar</span>
          </Button>
          
          <button
            onClick={() => {
              if (currentPage !== 'dashboard') {
                window.history.pushState({}, '', withBase('/'));
                onNavigate?.('dashboard');
              }
            }}
            className="flex items-center gap-2 py-1 hover:opacity-80 transition-opacity"
          >
            <img
              src={withBase('/logo.png')}
              alt="Gitea Mirror Logo"
              className="h-5 w-6"
            />
            <span className="text-xl font-bold hidden sm:inline">Gitea Mirror</span>
          </button>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          {showLiveButton && (
            <Button
              variant="outline"
              size="lg"
              className="flex items-center gap-1.5 px-3 sm:px-4"
              onClick={toggleLive}
              title={getTooltip()}
            >
              <div className={`size-4 sm:size-3 rounded-full ${
                configLoading
                  ? 'bg-yellow-400 animate-pulse'
                  : isLiveActive
                    ? 'bg-emerald-400 animate-pulse'
                    : isLiveEnabled
                      ? 'bg-orange-400'
                      : 'bg-gray-500'
              }`} />
              <span className="text-sm font-medium hidden sm:inline">LIVE</span>
            </Button>
          )}

          <ModeToggle />

          {isLoading ? (
            <AuthButtonsSkeleton />
          ) : user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="lg" className="relative h-10 w-10 rounded-full p-0">
                  <Avatar className="h-full w-full">
                    <AvatarImage src={user.image || ""} alt={user.name || user.email} />
                    <AvatarFallback>
                      {(user.name || user.email || "U").charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={handleLogout} className="cursor-pointer">
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <a href={withBase('/login')}>Login</a>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
