import { CardSection, SettingsCard } from "@/components/config/settings-ui";
import { Button } from "@/components/ui/button";
import { Server } from "lucide-react";
import type { Server as ServerRecord } from "@/lib/db/schema";
import { ServerForm } from "./ServerForm";

interface ServerCardProps {
  server?: ServerRecord | null;
  onSaved: () => void | Promise<unknown>;
  onCancel: () => void;
}

export function ServerCard({ server = null, onSaved, onCancel }: ServerCardProps) {
  return (
    <SettingsCard
      icon={Server}
      title={server ? `${server.name} Connection` : "New Server Connection"}
      headerAction={
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      }
    >
      <CardSection>
        <ServerForm
          server={server}
          onSaved={onSaved}
          onCancel={onCancel}
          showCancel={false}
        />
      </CardSection>
    </SettingsCard>
  );
}
