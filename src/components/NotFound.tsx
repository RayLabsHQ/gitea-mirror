import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Home, ArrowLeft, GitBranch, BookOpen, Settings, FileQuestion } from "lucide-react";
import { withBase } from "@/lib/base-path";

export function NotFound() {
  return (
    <div className="h-dvh bg-muted/30 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-muted flex items-center justify-center">
            <FileQuestion className="h-8 w-8 text-muted-foreground" />
          </div>
          <h1 className="text-3xl font-bold">404</h1>
          <h2 className="text-xl font-semibold mt-2">Page Not Found</h2>
          <p className="text-muted-foreground mt-2">
            The page you're looking for doesn't exist or has been moved.
          </p>
        </CardHeader>
        
        <CardContent className="space-y-6">
          {/* Action Buttons */}
          <div className="flex flex-col gap-3">
            <Button asChild className="w-full">
              <a href={withBase("/")}>
                <Home className="mr-2 h-4 w-4" />
                Go to Dashboard
              </a>
            </Button>
            <Button variant="outline" className="w-full" onClick={() => window.history.back()}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Go Back
            </Button>
          </div>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or visit</span>
            </div>
          </div>

          {/* Quick Links */}
          <div className="grid grid-cols-3 gap-3">
            <a 
              href={withBase("/repositories")} 
              className="flex flex-col items-center gap-2 p-3 rounded-md hover:bg-muted transition-colors"
            >
              <GitBranch className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs">Repositories</span>
            </a>
            <a 
              href={withBase("/config")} 
              className="flex flex-col items-center gap-2 p-3 rounded-md hover:bg-muted transition-colors"
            >
              <Settings className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs">Config</span>
            </a>
            <a 
              href={withBase("/docs")} 
              className="flex flex-col items-center gap-2 p-3 rounded-md hover:bg-muted transition-colors"
            >
              <BookOpen className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs">Docs</span>
            </a>
          </div>

          {/* Error Code */}
          <div className="text-center pt-2">
            <p className="text-xs text-muted-foreground">
              Error Code: <code className="font-mono">404_NOT_FOUND</code>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
