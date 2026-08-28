import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, GitCompareArrows, LoaderCircle, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CardSection,
  SettingsCard,
  StatusFooterItem,
} from "@/components/config/settings-ui";
import type { MirrorPairOptions, MirrorType, Server } from "@/lib/db/schema";
import { withBase } from "@/lib/base-path";
import { apiRequest, showErrorToast } from "@/lib/utils";
import { DEFAULT_PAIR_OPTIONS, PairOptionCards } from "./PairOptionCards";
import {
  SERVER_TYPE_LABELS,
  usernamesForType,
  type MatrixPairApiResponse,
  type ServersApiResponse,
} from "./shared";

export function CreateMirrorPairPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [sourceServerId, setSourceServerId] = useState("");
  const [targetServerId, setTargetServerId] = useState("");
  const [mirrorType, setMirrorType] = useState<MirrorType | "">("");
  const [username, setUsername] = useState("");
  const [options, setOptions] = useState<MirrorPairOptions>(DEFAULT_PAIR_OPTIONS);

  useEffect(() => {
    const fetchServers = async () => {
      try {
        const response = await apiRequest<ServersApiResponse>("/servers", { method: "GET" });
        setServers(response.servers ?? []);
      } catch (error) {
        showErrorToast(error, toast);
      } finally {
        setIsLoading(false);
      }
    };
    fetchServers();
  }, []);

  const sourceServer = useMemo(
    () => servers.find((server) => server.id === sourceServerId),
    [servers, sourceServerId]
  );
  const targetServer = useMemo(
    () => servers.find((server) => server.id === targetServerId),
    [servers, targetServerId]
  );
  const usernames = sourceServer ? usernamesForType(servers, sourceServer.type) : [];
  const pairIsComplete = Boolean(
    sourceServerId &&
      targetServerId &&
      sourceServerId !== targetServerId &&
      mirrorType &&
      username
  );

  const goBack = () => {
    window.location.href = withBase("/servers?tab=matrix");
  };

  const handleSave = async () => {
    if (!pairIsComplete) {
      toast.error("Choose a source, target, mirror type, and username first.");
      return;
    }

    try {
      setIsSaving(true);
      const response = await apiRequest<MatrixPairApiResponse>("/matrix", {
        method: "POST",
        data: {
          sourceServerId,
          targetServerId,
          mirrorType,
          username,
          options,
        },
      });

      if (response.success) {
        toast.success(response.message || "Mirror pair created");
        window.location.href = withBase("/servers?tab=matrix");
      } else {
        showErrorToast(response.message || "Failed to create mirror pair", toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" onClick={goBack} aria-label="Back to mirror pairs">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold leading-none tracking-tight">Create Mirror Pair</h1>
            <p className="text-sm text-muted-foreground">Choose the connection, then configure how repositories are mirrored.</p>
          </div>
        </div>
        <Button onClick={handleSave} disabled={!pairIsComplete || isSaving || isLoading}>
          {isSaving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save
        </Button>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-6">
          <SettingsCard
            icon={GitCompareArrows}
            title="Add Mirror Pair"
            footer={<StatusFooterItem icon={GitCompareArrows} label="Required before pair options can be configured" />}
          >
          <CardSection>
            {isLoading ? (
              <div className="flex min-h-32 items-center justify-center">
                <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : servers.length < 2 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                At least two servers are required. Add another server before creating a mirror pair.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Source Server
                  </Label>
                  <Select
                    value={sourceServerId}
                    onValueChange={(value) => {
                      setSourceServerId(value);
                      setUsername("");
                      if (targetServerId === value) {
                        setTargetServerId("");
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select source server" />
                    </SelectTrigger>
                    <SelectContent>
                      {servers.map((server) => (
                        <SelectItem key={server.id} value={server.id}>
                          {server.name} ({SERVER_TYPE_LABELS[server.type]})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Target Server
                  </Label>
                  <Select value={targetServerId} onValueChange={setTargetServerId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select target server" />
                    </SelectTrigger>
                    <SelectContent>
                      {servers
                        .filter((server) => server.id !== sourceServerId)
                        .map((server) => (
                          <SelectItem key={server.id} value={server.id}>
                            {server.name} ({SERVER_TYPE_LABELS[server.type]})
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Mirror Type
                  </Label>
                  <Select
                    value={mirrorType}
                    onValueChange={(value) => setMirrorType(value as MirrorType)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select mirror type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="one-way">Source to Target</SelectItem>
                      <SelectItem value="two-way">Two Way Mirror</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Username
                  </Label>
                  <Select
                    value={username}
                    onValueChange={setUsername}
                    disabled={!sourceServer || usernames.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          sourceServer
                            ? "Select username"
                            : "Select a source server first"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {usernames.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </CardSection>
          </SettingsCard>

          <PairOptionCards
            column="left"
            options={options}
            onChange={setOptions}
            sourceServer={sourceServer}
            targetServer={targetServer}
            disabled={!pairIsComplete}
          />
        </div>

        <PairOptionCards
          column="right"
          options={options}
          onChange={setOptions}
          sourceServer={sourceServer}
          targetServer={targetServer}
          disabled={!pairIsComplete}
        />
      </div>

      <div className="flex justify-between border-t pt-6">
        <Button variant="outline" onClick={goBack}><ArrowLeft className="mr-2 h-4 w-4" />Back</Button>
        <Button onClick={handleSave} disabled={!pairIsComplete || isSaving || isLoading}>
          {isSaving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save
        </Button>
      </div>
    </div>
  );
}
