import * as React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { LoaderCircle, Plus } from "lucide-react";
import { SiGithub } from "react-icons/si";
import type { MembershipRole } from "@/types/organizations";
import type { SourceApiRecord } from "@/types/config";
import { RadioGroup, RadioGroupItem } from "../ui/radio";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { parseGitHubOwnerReference } from "@/lib/utils/github-url";
import {
  SOURCE_PROVIDER_DEFAULT_URLS,
  SOURCE_PROVIDER_LABELS,
  SOURCE_PROVIDER_ORG_NOUNS,
  normalizeSourceUrl,
  type SourceProviderKind,
} from "@/lib/source-providers/kinds";
import { SOURCE_PROVIDER_ICONS } from "@/lib/source-providers/icons";

const inputClassName =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface AddOrganizationDialogProps {
  isDialogOpen: boolean;
  setIsDialogOpen: (isOpen: boolean) => void;
  onAddOrganization: ({
    org,
    role,
    force,
    sourceId,
  }: {
    org: string;
    role: MembershipRole;
    force?: boolean;
    sourceId?: string;
  }) => Promise<void>;
  sourceProvider?: SourceProviderKind;
  /** Normalized instance URL of the configured source, for the placeholder. */
  sourceUrl?: string;
  /** Connected sources; with more than one, the dialog asks which one to add from. */
  sources?: SourceApiRecord[];
}

export default function AddOrganizationDialog({
  isDialogOpen,
  setIsDialogOpen,
  onAddOrganization,
  sourceProvider = "github",
  sourceUrl,
  sources,
}: AddOrganizationDialogProps) {
  const [url, setUrl] = useState<string>("");
  const [org, setOrg] = useState<string>("");
  const [role, setRole] = useState<MembershipRole>("member");
  const [sourceId, setSourceId] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const hasMultipleSources = !!sources && sources.length > 1;
  // With several connected sources, the chosen one drives every
  // provider-dependent label; otherwise the global source props do.
  const selectedSource = hasMultipleSources
    ? sources.find((source) => source.id === sourceId) ?? sources[0]
    : undefined;
  const effectiveProvider: SourceProviderKind =
    selectedSource?.provider ?? sourceProvider;
  const effectiveSourceUrl = selectedSource
    ? normalizeSourceUrl(selectedSource.url, selectedSource.provider)
    : sourceUrl;

  const providerLabel = SOURCE_PROVIDER_LABELS[effectiveProvider];
  const orgNoun = SOURCE_PROVIDER_ORG_NOUNS[effectiveProvider];
  const orgNounCapitalized = orgNoun.charAt(0).toUpperCase() + orgNoun.slice(1);
  // "an organization" but "a group".
  const orgNounWithArticle = `${/^[aeiou]/i.test(orgNoun) ? "an" : "a"} ${orgNoun}`;
  const instanceUrl = (
    effectiveSourceUrl || SOURCE_PROVIDER_DEFAULT_URLS[effectiveProvider]
  ).replace(/\/+$/, "");
  const urlPlaceholder = `${instanceUrl}/your-${orgNoun}`;

  const resetForm = () => {
    setError("");
    setUrl("");
    setOrg("");
    setRole("member");
    setSourceId("");
  };

  useEffect(() => {
    if (!isDialogOpen) {
      resetForm();
    }
  }, [isDialogOpen]);

  // Default the picker to the primary source (oldest first) whenever the
  // selection is empty or points at a removed source.
  useEffect(() => {
    if (!hasMultipleSources) {
      return;
    }
    if (!sources.some((source) => source.id === sourceId)) {
      setSourceId(sources[0].id);
    }
  }, [hasMultipleSources, sources, sourceId]);

  /** Fill the name field from anything that names an account. */
  const applyReference = (value: string): boolean => {
    const parsed = parseGitHubOwnerReference(value);
    if (!parsed) return false;
    setOrg(parsed);
    setError("");
    return true;
  };

  const handleUrlChange = (value: string) => {
    setUrl(value);
    if (!value.trim()) return;
    if (!applyReference(value)) {
      setOrg("");
    }
  };

  /** Pasting a URL into the name box fills the name rather than the whole URL. */
  const handleReferencePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted.includes("/")) return;
    if (applyReference(pasted)) {
      e.preventDefault();
      setUrl(pasted.trim());
    }
  };

  const urlIsUnparsed = url.trim() !== "" && !org;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!org || org.trim() === "") {
      setError(
        urlIsUnparsed
          ? `That does not look like a ${providerLabel} ${orgNoun} URL.`
          : `Please enter a valid ${orgNoun} name.`
      );
      return;
    }

    try {
      setIsLoading(true);

      await onAddOrganization({
        org,
        role,
        sourceId: selectedSource?.id,
      });

      resetForm();
      setIsDialogOpen(false);
    } catch (err: any) {
      setError(err?.message || "Failed to add organization.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
      <DialogTrigger asChild>
        <Button className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 rounded-full h-12 w-12 shadow-lg p-0 z-10">
          <Plus className="h-6 w-6" />
        </Button>
      </DialogTrigger>

      <DialogContent className="w-[calc(100%-2rem)] sm:max-w-[425px] gap-0 gap-y-6 mx-4 sm:mx-0">
        <DialogHeader>
          <DialogTitle>Add {orgNounCapitalized}</DialogTitle>
          <DialogDescription>
            {`You can add public ${orgNoun}s`}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-y-6">
          <div className="space-y-4">
            {hasMultipleSources && (
              <div>
                <label
                  htmlFor="organizationSource"
                  className="block text-sm font-medium mb-1.5"
                >
                  Source
                </label>
                <Select value={sourceId} onValueChange={setSourceId}>
                  <SelectTrigger id="organizationSource" className="w-full">
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((source) => {
                      const SourceIcon =
                        SOURCE_PROVIDER_ICONS[source.provider] ?? SiGithub;
                      return (
                        <SelectItem key={source.id} value={source.id}>
                          <span className="flex items-center gap-2">
                            <SourceIcon className="h-3.5 w-3.5" />
                            {source.name}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <label
                htmlFor="organizationUrl"
                className="block text-sm font-medium mb-1.5"
              >
                {providerLabel} URL
              </label>
              <input
                id="organizationUrl"
                type="text"
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                className={inputClassName}
                placeholder={urlPlaceholder}
                autoComplete="off"
                autoFocus
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {urlIsUnparsed
                  ? `Could not read ${orgNounWithArticle} from that.`
                  : `Paste ${orgNounWithArticle} URL and the name below fills in.`}
              </p>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-background px-2 text-xs uppercase tracking-wider text-muted-foreground">
                  or
                </span>
              </div>
            </div>

            <div>
              <label
                htmlFor="organizationName"
                className="block text-sm font-medium mb-1.5"
              >
                {orgNounCapitalized} Name
              </label>
              <input
                id="organizationName"
                type="text"
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                onPaste={handleReferencePaste}
                className={inputClassName}
                placeholder={`e.g., your-${orgNoun}`}
                autoComplete="off"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Membership Role
              </label>

              <RadioGroup
                value={role}
                onValueChange={(val) => setRole(val as MembershipRole)}
                className="flex flex-col gap-y-2"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="member" id="r1" />
                  <Label htmlFor="r1">Member</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="admin" id="r2" />
                  <Label htmlFor="r2">Admin</Label>
                </div>
                {effectiveProvider === "github" && (
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="billing_manager" id="r3" />
                    <Label htmlFor="r3">Billing Manager</Label>
                  </div>
                )}
              </RadioGroup>
            </div>

            {error && <p className="text-sm text-red-500 mt-1">{error}</p>}
          </div>

          <div className="flex justify-between">
            <Button
              type="button"
              variant="outline"
              disabled={isLoading}
              onClick={() => setIsDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                `Add ${orgNounCapitalized}`
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
