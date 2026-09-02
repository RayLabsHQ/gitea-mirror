import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Check, Copy, Info, Key, Loader2, Plus, Trash2 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { cn, formatDateShort, formatLastSyncTime } from '@/lib/utils';
import {
  API_KEY_EXPIRY_OPTIONS,
  API_KEY_HEADER,
  API_KEY_NAME_MAX_LENGTH,
  describeKeyExpiry,
  expiryOptionToSeconds,
  isKeyExpired,
  maskKeyStart,
  normalizeKeyName,
  type ApiKeyExpiryOption,
} from '@/lib/api-keys';

const DOCS_URL = 'https://github.com/RayLabsHQ/gitea-mirror/blob/main/docs/API.md';

/** The subset of the plugin's key record the list needs. The secret never comes back. */
interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: string | Date;
  lastRequest: string | Date | null;
  expiresAt: string | Date | null;
  enabled: boolean;
}

function toRows(data: unknown): ApiKeyRow[] {
  // 1.7 returns { apiKeys, total }; older builds returned the bare array.
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { apiKeys?: unknown }).apiKeys)
      ? (data as { apiKeys: unknown[] }).apiKeys
      : [];
  return list
    .map((item) => item as ApiKeyRow)
    .filter((item) => item && typeof item.id === 'string')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

/**
 * Personal API keys for scripts and CI (issue #314). Keys belong to the
 * signed-in user and carry the same rights as their session. The secret
 * is shown once, right after creation, and only its first characters are
 * stored afterwards.
 */
export function ApiKeysSettings() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<ApiKeyExpiryOption>('never');
  const [nameError, setNameError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const result = await authClient.apiKey.list();
      if (result.error) {
        setLoadError(errorMessage(result.error, 'Could not load API keys.'));
        return;
      }
      setKeys(toRows(result.data));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, 'Could not load API keys.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const resetDialog = () => {
    setName('');
    setExpiry('never');
    setNameError(null);
    setCreatedKey(null);
    setCopied(false);
  };

  const handleDialogChange = (open: boolean) => {
    if (!open && isCreating) return;
    setDialogOpen(open);
    if (!open) resetDialog();
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeKeyName(name);
    if (normalized.error) {
      setNameError(normalized.error);
      return;
    }
    setNameError(null);
    setIsCreating(true);
    try {
      const expiresIn = expiryOptionToSeconds(expiry);
      const result = await authClient.apiKey.create({
        name: normalized.value,
        ...(expiresIn !== undefined ? { expiresIn } : {}),
      });
      if (result.error || !result.data?.key) {
        toast.error(errorMessage(result.error, 'Could not create the API key.'));
        return;
      }
      setCreatedKey({ name: normalized.value, secret: result.data.key });
      toast.success('API key created');
      await loadKeys();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not create the API key.'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy. Select the key and copy it by hand.');
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      const result = await authClient.apiKey.delete({ keyId: id });
      if (result.error) {
        toast.error(errorMessage(result.error, 'Could not revoke the API key.'));
        return;
      }
      setKeys((current) => current.filter((row) => row.id !== id));
      toast.success('API key revoked');
    } catch (error) {
      toast.error(errorMessage(error, 'Could not revoke the API key.'));
    } finally {
      setRevokingId(null);
      setPendingRevokeId(null);
    }
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-3">
          <Key className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-base font-semibold">API Keys</h3>
        </div>
        <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
          <Button
            size="sm"
            className="bg-indigo-500 text-white hover:bg-indigo-600"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Create key
          </Button>
          <DialogContent className="max-w-lg">
            {createdKey ? (
              <>
                <DialogHeader>
                  <DialogTitle>Key created</DialogTitle>
                  <DialogDescription>
                    This is the only time the key for <span className="font-medium text-foreground">{createdKey.name}</span> is
                    shown. Copy it now and store it somewhere safe.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex items-stretch gap-2">
                  <code
                    className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-5"
                    data-testid="api-key-secret"
                  >
                    {createdKey.secret}
                  </code>
                  <Button type="button" variant="outline" size="sm" className="h-auto" onClick={handleCopy}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Send it in the <code className="font-mono">{API_KEY_HEADER}</code> header. If you lose it, revoke this key and
                  create a new one.
                </p>
                <DialogFooter>
                  <Button type="button" onClick={() => handleDialogChange(false)}>
                    Done
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <form onSubmit={handleCreate} className="flex flex-col gap-4">
                <DialogHeader>
                  <DialogTitle>Create API key</DialogTitle>
                  <DialogDescription>
                    The key acts as you: anything your account can do through the app, a script holding this key can do too.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <Label htmlFor="api-key-name">Name</Label>
                  <Input
                    id="api-key-name"
                    value={name}
                    maxLength={API_KEY_NAME_MAX_LENGTH}
                    placeholder="e.g. ci-deploy"
                    autoComplete="off"
                    onChange={(event) => {
                      setName(event.target.value);
                      if (nameError) setNameError(null);
                    }}
                  />
                  {nameError ? (
                    <p className="text-xs text-destructive">{nameError}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Something that tells you where the key is used.</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="api-key-expiry">Expires</Label>
                  <Select value={expiry} onValueChange={(value) => setExpiry(value as ApiKeyExpiryOption)}>
                    <SelectTrigger id="api-key-expiry" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {API_KEY_EXPIRY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => handleDialogChange(false)} disabled={isCreating}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isCreating}>
                    {isCreating && <Loader2 className="h-4 w-4 animate-spin" />}
                    Create key
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>
      <div className="border-t border-border" />

      <div className="flex-1 p-6">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-start gap-3 text-sm">
            <p className="text-muted-foreground">{loadError}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadKeys()}>
              Try again
            </Button>
          </div>
        ) : keys.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <Key className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No API keys yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Create one to add repositories or start mirrors from scripts, CI pipelines and workflow tools.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            <div className="hidden pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_5.5rem] sm:gap-4">
              <span>Key</span>
              <span>Created</span>
              <span>Last used</span>
              <span>Expires</span>
              <span className="sr-only">Actions</span>
            </div>
            {keys.map((row) => {
              const expired = isKeyExpired(row.expiresAt);
              const inactive = expired || row.enabled === false;
              const isPending = pendingRevokeId === row.id;
              const isRevoking = revokingId === row.id;
              return (
                <div
                  key={row.id}
                  data-testid="api-key-row"
                  className="flex flex-col gap-2 py-3 sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_5.5rem] sm:items-center sm:gap-4"
                >
                  <div className="min-w-0">
                    <p className={cn('truncate text-sm font-medium', inactive && 'text-muted-foreground')}>
                      {row.name || 'Unnamed key'}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{maskKeyStart(row.start)}</p>
                  </div>
                  <p className="text-xs text-muted-foreground sm:text-sm">
                    <span className="sm:hidden">Created </span>
                    {formatDateShort(row.createdAt) ?? 'Unknown'}
                  </p>
                  <p className="text-xs text-muted-foreground sm:text-sm">
                    <span className="sm:hidden">Last used </span>
                    {row.lastRequest ? formatLastSyncTime(row.lastRequest) : 'Never used'}
                  </p>
                  <p className={cn('text-xs sm:text-sm', expired ? 'text-destructive' : 'text-muted-foreground')}>
                    <span className="sm:hidden">Expires </span>
                    {describeKeyExpiry(row.expiresAt)}
                  </p>
                  <div className="flex items-center justify-end gap-1">
                    {isPending ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingRevokeId(null)}
                          disabled={isRevoking}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => void handleRevoke(row.id)}
                          disabled={isRevoking}
                        >
                          {isRevoking ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Revoke'}
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Revoke ${row.name || 'key'}`}
                        onClick={() => setPendingRevokeId(row.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border" />
      <div className="flex items-center gap-2 px-6 py-3.5 text-xs text-muted-foreground/70">
        <Info className="h-3.5 w-3.5" />
        <span>
          Send the key in the <code className="font-mono">{API_KEY_HEADER}</code> header.{' '}
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
            API docs
          </a>
        </span>
      </div>
    </div>
  );
}
