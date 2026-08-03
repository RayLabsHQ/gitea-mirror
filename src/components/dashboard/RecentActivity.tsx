import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MirrorJob } from "@/lib/db/schema";
import { formatDate } from "@/lib/utils";
import { Button } from "../ui/button";
import {
  Activity,
  CircleCheck,
  Clock,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { withBase } from "@/lib/base-path";
import { useTimeFormat } from "@/hooks/useTimeFormat";

interface RecentActivityProps {
  activities: MirrorJob[];
}

function activityIcon(status: MirrorJob["status"]) {
  switch (status) {
    case "mirrored":
    case "synced":
      return { Icon: CircleCheck, color: "text-green-500" };
    case "mirroring":
    case "syncing":
      return { Icon: RefreshCw, color: "text-indigo-400" };
    case "imported":
      return { Icon: Sparkles, color: "text-muted-foreground" };
    case "failed":
      return { Icon: TriangleAlert, color: "text-red-500" };
    default:
      return { Icon: Activity, color: "text-muted-foreground" };
  }
}

export function RecentActivity({ activities }: RecentActivityProps) {
  // Re-render timestamps when the user changes the 12h/24h preference.
  useTimeFormat();

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-3 text-base font-semibold">
          <Activity className="h-5 w-5 text-muted-foreground" />
          Recent Activity
        </CardTitle>
        <Button variant="ghost" size="sm" asChild className="text-indigo-500 hover:text-indigo-600">
          <a href={withBase("/activity")}>View all</a>
        </Button>
      </CardHeader>
      <CardContent>
        {activities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Clock className="h-10 w-10 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No recent activity</h3>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Activity will appear here when you start mirroring repositories.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={withBase("/activity")}>
                  <Activity className="h-3.5 w-3.5 mr-1.5" />
                  View History
                </a>
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {activities.map((activity, index) => {
              const { Icon, color } = activityIcon(activity.status);
              return (
                <div key={index} className="flex items-center gap-x-3 py-3">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-muted">
                    <Icon className={`h-4 w-4 ${color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium">
                      {activity.message}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatDate(activity.timestamp)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
