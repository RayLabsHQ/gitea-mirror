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
  }) => Promise<void>;
}

export default function AddRepositoryDialog({
  isDialogOpen,
  setIsDialogOpen,
  onAddRepository,
}: AddRepositoryDialogProps) {
  const [repo, setRepo] = useState<string>("");
  const [owner, setOwner] = useState<string>("");
  const [destinationOrg, setDestinationOrg] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!isDialogOpen) {
      setError("");
      setRepo("");
      setOwner("");
      setDestinationOrg("");
    }
  }, [isDialogOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!repo || !owner || repo.trim() === "" || owner.trim() === "") {
      setError("Please enter a valid repository name and owner.");
      return;
    }

    try {
      setIsLoading(true);

      await onAddRepository({
        repo,
        owner,
        destinationOrg: destinationOrg.trim() || undefined,
      });

      setError("");
      setRepo("");
      setOwner("");
      setDestinationOrg("");
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
                htmlFor="name"
                className="block text-sm font-medium mb-1.5"
              >
                Repository Name
              </label>
              <input
                id="name"
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="e.g., next.js"
                autoComplete="off"
                autoFocus
                required
              />
            </div>

            <div>
              <label
                htmlFor="name"
                className="block text-sm font-medium mb-1.5"
              >
                Repository Owner
              </label>
              <input
                id="name"
                type="text"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
