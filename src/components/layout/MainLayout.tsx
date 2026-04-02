import { useState, useEffect, createContext, useContext } from "react";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { Dashboard } from "@/components/dashboard/Dashboard";
import Repository from "../repositories/Repository";
import Providers from "./Providers";
import { ConfigTabs } from "../config/ConfigTabs";
import { ActivityLog } from "../activity/ActivityLog";
import { Organization } from "../organizations/Organization";
import { Toaster } from "@/components/ui/sonner";
import { useAuth } from "@/hooks/useAuth";
import { useRepoSync } from "@/hooks/useSyncRepo";
import { useConfigStatus } from "@/hooks/useConfigStatus";
import { stripBasePath, withBase } from "@/lib/base-path";

// Navigation context to signal when navigation happens
const NavigationContext = createContext<{ navigationKey: number }>({ navigationKey: 0 });

export const useNavigation = () => useContext(NavigationContext);

interface AppProps {
  page:
    | "dashboard"
    | "repositories"
    | "organizations"
    | "configuration"
    | "activity-log";
  "client:load"?: boolean;
  "client:idle"?: boolean;
  "client:visible"?: boolean;
  "client:media"?: string;
  "client:only"?: boolean | string;
}

export default function App({ page }: AppProps) {
  return (
    <Providers>
      <AppWithProviders page={page} />
    </Providers>
  );
}

function AppWithProviders({ page: initialPage }: AppProps) {
  const { user, isLoading: authLoading } = useAuth();
  const { isLoading: configLoading } = useConfigStatus();
  const [currentPage, setCurrentPage] = useState<AppProps['page']>(initialPage);
  const [navigationKey, setNavigationKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    // Check if we're on medium screens (768px - 1280px)
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 768 && window.innerWidth < 1280;
    }
    return false;
  });

  useRepoSync({
    userId: user?.id,
    enabled: false, // TODO: Get from config
    interval: 3600, // TODO: Get from config
    lastSync: null,
    nextSync: null,
  });

  // Handle navigation from sidebar
  const handleNavigation = (pageName: string) => {
    setCurrentPage(pageName as AppProps['page']);
    // Increment navigation key to force components to refresh their loading state
    setNavigationKey(prev => prev + 1);
  };

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const path = stripBasePath(window.location.pathname);
      const pageMap: Record<string, AppProps['page']> = {
        '/': 'dashboard',
        '/repositories': 'repositories',
        '/organizations': 'organizations',
        '/config': 'configuration',
        '/activity': 'activity-log'
      };

      const pageName = pageMap[path] || 'dashboard';
      setCurrentPage(pageName);
      // Also increment navigation key for browser navigation to trigger loading states
      setNavigationKey(prev => prev + 1);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Handle window resize to auto-collapse sidebar on medium screens
  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      // Auto-collapse on medium screens (768px - 1280px)
      if (width >= 768 && width < 1280) {
        setSidebarCollapsed(true);
      } else if (width >= 1280) {
        // Expand on large screens
        setSidebarCollapsed(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Show loading state only during initial auth/config loading
  const isInitialLoading = authLoading || (configLoading && !user);

  if (isInitialLoading) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </main>
    );
  }

  // Redirect to login if not authenticated
  if (!authLoading && !user) {
    // Use window.location for client-side redirect
    if (typeof window !== 'undefined') {
      window.location.href = withBase('/login');
    }
    return null;
  }

  return (
    <NavigationContext.Provider value={{ navigationKey }}>
      <main className="flex min-h-screen flex-col">
        <Header 
          currentPage={currentPage} 
          onNavigate={handleNavigation} 
          onMenuClick={() => setSidebarOpen(!sidebarOpen)}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          isSidebarCollapsed={sidebarCollapsed}
          isSidebarOpen={sidebarOpen}
        />
        <div className="flex flex-1 relative">
          <Sidebar 
            onNavigate={handleNavigation} 
            isOpen={sidebarOpen}
            isCollapsed={sidebarCollapsed}
            onClose={() => setSidebarOpen(false)}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          />
          <section className={`flex-1 p-4 sm:p-6 overflow-y-auto h-[calc(100dvh-4.55rem)] w-full transition-all duration-200 ${
            sidebarCollapsed ? 'md:w-[calc(100%-5rem)] xl:w-[calc(100%-16rem)]' : 'md:w-[calc(100%-16rem)]'
          }`}>
            {currentPage === "dashboard" && <Dashboard />}
            {currentPage === "repositories" && <Repository />}
            {currentPage === "organizations" && <Organization />}
            {currentPage === "configuration" && <ConfigTabs />}
            {currentPage === "activity-log" && <ActivityLog />}
          </section>
        </div>
        <Toaster position="top-center" />
      </main>
    </NavigationContext.Provider>
  );
}
