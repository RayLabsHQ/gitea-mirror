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
import {
  parseGitHubRepoReference,
  parseRepoReferenceParts,
  type RepoReferenceParts,
} from "@/lib/utils/github-url";

const inputClassName =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface AddRepositoryDialogProps {
  isDialogOpen: boolean;
  setIsDialogOpen: (isOpen: boolean) => void;
  onAddRepository: ({
    repo,
    owner,
    force,
    destinationOrg,
  }: {
    repo: string;
    owner: string;
    force?: boolean;
    destinationOrg?: string;
    host?: string;
    path?: string[];
  }) => Promise<void>;
}

export default function AddRepositoryDialog({
  isDialogOpen,
  setIsDialogOpen,
  onAddRepository,
}: AddRepositoryDialogProps) {
  const [url, setUrl] = useState<string>("");
  const [repo, setRepo] = useState<string>("");
  const [owner, setOwner] = useState<string>("");
  const [destinationOrg, setDestinationOrg] = useState<string>("");
  /** Host and path of the pasted URL, resolved per source on the server. */
  const [reference, setReference] = useState<RepoReferenceParts | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const resetForm = () => {
    setError("");
    setUrl("");
    setRepo("");
    setOwner("");
    setDestinationOrg("");
    setReference(null);
  };

  useEffect(() => {
    if (!isDialogOpen) {
      resetForm();
    }
  }, [isDialogOpen]);

  /** Fill the name and owner fields from anything that names a repository. */
  const applyReference = (value: string): boolean => {
    const parsed = parseGitHubRepoReference(value);
    if (!parsed) return false;
    setOwner(parsed.owner);
    setRepo(parsed.repo);
    setReference(parseRepoReferenceParts(value));
    setError("");
    return true;
  };

  const handleUrlChange = (value: string) => {
    setUrl(value);
    if (!value.trim()) return;
    if (!applyReference(value)) {
      setOwner("");
      setRepo("");
      setReference(null);
    }
  };

  /** Pasting a URL into the name box fills both fields rather than one bad one. */
  const handleReferencePaste =
    (fallback: (value: string) => void) =>
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const pasted = e.clipboardData.getData("text");
      if (!pasted.includes("/")) return;
      if (applyReference(pasted)) {
        e.preventDefault();
        setUrl(pasted.trim());
      } else {
        fallback(pasted);
      }
    };

  const urlIsUnparsed = url.trim() !== "" && (!owner || !repo);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!repo || !owner || repo.trim() === "" || owner.trim() === "") {
      setError(
        urlIsUnparsed
          ? "That does not look like a repository URL."
          : "Please enter a valid repository name and owner."
      );
      return;
    }

    try {
      setIsLoading(true);

      await onAddRepository({
        repo,
        owner,
        destinationOrg: destinationOrg.trim() || undefined,
        host: reference?.host ?? undefined,
        path: reference?.segments,
      });

      resetForm();
      setIsDialogOpen(false);
    } catch (err: any) {
      setError(err?.message || "Failed to add repository.");
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
          <DialogTitle>Add Repository</DialogTitle>
          <DialogDescription>
            You can add public repositories of others
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-y-6">
          <div className="space-y-4">
            <div>
              <label
                htmlFor="repositoryUrl"
                className="block text-sm font-medium mb-1.5"
              >
                Repository URL
              </label>
              <input
                id="repositoryUrl"
                type="text"
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                className={inputClassName}
                placeholder="https://github.com/vercel/next.js"
                autoComplete="off"
                autoFocus
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {urlIsUnparsed
                  ? "Could not read an owner and repository from that."
                  : "Paste a repository URL and the fields below fill in."}
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
                htmlFor="repositoryName"
                className="block text-sm font-medium mb-1.5"
              >
                Repository Name
              </label>
              <input
                id="repositoryName"
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                onPaste={handleReferencePaste((value) => setRepo(value))}
                className={inputClassName}
                placeholder="e.g., next.js"
                autoComplete="off"
                required
              />
            </div>

            <div>
              <label
                htmlFor="repositoryOwner"
                className="block text-sm font-medium mb-1.5"
              >
                Repository Owner
              </label>
              <input
                id="repositoryOwner"
                type="text"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                onPaste={handleReferencePaste((value) => setOwner(value))}
                className={inputClassName}
                placeholder="e.g., vercel"
                autoComplete="off"
                required
              />
            </div>

            <div>
              <label
                htmlFor="destinationOrg"
                className="block text-sm font-medium mb-1.5"
              >
                Target Organization{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </label>
              <input
                id="destinationOrg"
                type="text"
                value={destinationOrg}
                onChange={(e) => setDestinationOrg(e.target.value)}
                className={inputClassName}
                placeholder="Gitea org or user (uses default strategy if empty)"
                autoComplete="off"
              />
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
                "Add Repository"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
