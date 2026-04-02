import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ExternalLink } from "lucide-react";
import { links } from "@/data/Sidebar";
import { VersionInfo } from "./VersionInfo";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { stripBasePath, withBase } from "@/lib/base-path";

interface SidebarProps {
  className?: string;
  onNavigate?: (page: string) => void;
  isOpen: boolean;
  isCollapsed?: boolean;
  onClose: () => void;
  onToggleCollapse?: () => void;
}

export function Sidebar({ className, onNavigate, isOpen, isCollapsed = false, onClose, onToggleCollapse }: SidebarProps) {
  const [currentPath, setCurrentPath] = useState<string>("");

  useEffect(() => {
    // Hydration happens here
    const path = stripBasePath(window.location.pathname);
    setCurrentPath(path);
  }, []);

  // Listen for URL changes (browser back/forward)
  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(stripBasePath(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleNavigation = (href: string, event: React.MouseEvent) => {
    event.preventDefault();

    // Don't navigate if already on the same page
    if (currentPath === href) return;

    // Update URL without page reload
    window.history.pushState({}, '', withBase(href));
    setCurrentPath(href);

    // Map href to page name for the parent component
    const pageMap: Record<string, string> = {
      '/': 'dashboard',
      '/repositories': 'repositories',
      '/organizations': 'organizations',
      '/config': 'configuration',
      '/activity': 'activity-log'
    };

    const pageName = pageMap[href] || 'dashboard';
    onNavigate?.(pageName);
    
    // Close sidebar on mobile after navigation
    if (window.innerWidth < 768) {
      onClose();
    }
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 backdrop-blur-sm z-40 md:hidden"
          onClick={onClose}
        />
      )}
      
      {/* Sidebar */}
      <aside 
        className={cn(
          "fixed md:static inset-y-0 left-0 z-50 bg-background border-r flex flex-col h-full md:h-[calc(100vh-4.5rem)] transition-all duration-200 ease-in-out md:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full",
          isCollapsed ? "md:w-20 xl:w-64" : "w-64",
          className
        )}
      >
        <div className="flex flex-col h-full">
          <nav className={cn(
            "flex flex-col pt-4 flex-shrink-0",
            isCollapsed 
              ? "md:gap-y-2 md:items-center md:px-2 xl:gap-y-1 xl:items-stretch xl:pl-2 xl:pr-3 gap-y-1 pl-2 pr-3" 
              : "gap-y-1 pl-2 pr-3"
          )}>
            {links.map((link, index) => {
              const isActive = currentPath === link.href;
              const Icon = link.icon;
              
              const button = (
                <button
                  key={index}
                  onClick={(e) => handleNavigation(link.href, e)}
                  className={cn(
                    "flex items-center rounded-md text-sm font-medium transition-colors w-full",
                    isCollapsed 
                      ? "md:h-12 md:w-12 md:justify-center md:p-0 xl:h-auto xl:w-full xl:justify-start xl:px-3 xl:py-2 h-auto px-3 py-3" 
                      : "px-3 py-3 md:py-2",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Icon className={cn(
                    "flex-shrink-0",
                    isCollapsed 
                      ? "md:h-5 md:w-5 md:mr-0 xl:h-4 xl:w-4 xl:mr-3 h-5 w-5 mr-3" 
                      : "h-5 w-5 md:h-4 md:w-4 mr-3"
                  )} />
                  <span className={cn(
                    "transition-all duration-200",
                    isCollapsed ? "md:hidden xl:inline" : "inline"
                  )}>
                    {link.label}
                  </span>
                </button>
              );

              // Wrap in tooltip when collapsed on medium screens
              if (isCollapsed) {
                return (
                  <TooltipProvider key={index}>
                    <Tooltip delayDuration={0}>
                      <TooltipTrigger asChild>
                        {button}
                      </TooltipTrigger>
                      <TooltipContent side="right" className="hidden md:block xl:hidden">
                        {link.label}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                );
              }

              return button;
            })}
          </nav>

          <div className="flex-1 min-h-0" />

          <div className={cn(
            "py-4 flex-shrink-0",
            isCollapsed ? "md:px-2 xl:px-4 px-4" : "px-4"
          )}>
            <div className={cn(
              "rounded-md bg-muted transition-all duration-200",
              isCollapsed ? "md:p-0 xl:p-3 p-3" : "p-3"
            )}>
              <div className={cn(
                isCollapsed ? "md:hidden xl:block" : "block"
              )}>
                <h4 className="text-sm font-medium mb-2">Need Help?</h4>
                <p className="text-xs text-muted-foreground mb-3 md:mb-2">
                  Check out the documentation for help with setup and configuration.
                </p>
                <a
                  href={withBase("/docs")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs md:text-xs text-primary hover:underline py-2 md:py-0"
                >
                  Documentation
                  <ExternalLink className="h-3.5 w-3.5 md:h-3 md:w-3" />
                </a>
              </div>
              {/* Icon-only help button for collapsed state on medium screens */}
              <TooltipProvider>
                <Tooltip delayDuration={0}>
                  <TooltipTrigger asChild>
                    <a
                      href={withBase("/docs")}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        "flex items-center justify-center rounded-md hover:bg-accent transition-colors",
                        isCollapsed ? "md:h-12 md:w-12 xl:hidden hidden" : "hidden"
                      )}
                    >
                      <ExternalLink className="h-5 w-5" />
                    </a>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    Documentation
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className={cn(
              isCollapsed ? "md:hidden xl:block" : "block"
            )}>
              <VersionInfo />
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
