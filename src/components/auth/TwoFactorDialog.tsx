import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Download, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QrCode } from "./QrCode";
import { manualEntryKey, twoFactorErrorText } from "@/lib/two-factor-ui";

/**
 * Where the dialog is: managing 2FA that is on, confirming the password for
 * an action, scanning the QR code, or showing backup codes.
 */
type Step =
  | { kind: "manage" }
  | { kind: "password"; purpose: "enable" | "disable" | "codes" }
  | { kind: "scan"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[]; fresh: boolean };

interface TwoFactorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
  /** Reload the session so the menu shows the new state. */
  onChanged: () => Promise<void> | void;
}

/**
 * 2FA for the signed-in account (#552), opened from the account menu. When
 * it is off this is the setup with an authenticator app; when it is on, it
 * makes new backup codes or turns 2FA off. Every action asks for the password.
 */
export function TwoFactorDialog({ open, onOpenChange, enabled, onChanged }: TwoFactorDialogProps) {
  const initial: Step = enabled ? { kind: "manage" } : { kind: "password", purpose: "enable" };
  const [step, setStep] = useState<Step>(initial);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"key" | "codes" | null>(null);

  const reset = () => {
    setStep(initial);
    setPassword("");
    setCode("");
    setBusy(false);
    setCopied(null);
  };

  // Start from the account's current state each time the dialog opens.
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    // A setup that was not finished leaves nothing switched on.
    if (!next) reset();
    onOpenChange(next);
  };

  const copy = async (text: string, what: "key" | "codes") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Could not copy. Select the text and copy it instead.");
    }
  };

  const download = (codes: string[]) => {
    const text = [
      "Gitea Mirror backup codes",
      `Saved ${new Date().toISOString().slice(0, 10)}. Each code works once.`,
      "",
      ...codes,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "gitea-mirror-backup-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== "password" || !password) return;
    setBusy(true);
    try {
      if (step.purpose === "enable") {
        const { data, error } = await authClient.twoFactor.enable({ password });
        if (error || !data || !("totpURI" in data) || !data.totpURI) {
          toast.error(twoFactorErrorText(error, "Could not start the setup"));
          return;
        }
        setStep({ kind: "scan", totpURI: data.totpURI, backupCodes: data.backupCodes ?? [] });
      } else if (step.purpose === "disable") {
        const { error } = await authClient.twoFactor.disable({ password });
        if (error) {
          toast.error(twoFactorErrorText(error, "Could not turn it off"));
          return;
        }
        toast.success("2FA is off");
        await onChanged();
        handleOpenChange(false);
      } else {
        const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
        if (error || !data) {
          toast.error(twoFactorErrorText(error, "Could not make new codes"));
          return;
        }
        setStep({ kind: "codes", backupCodes: data.backupCodes, fresh: false });
      }
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== "scan") return;
    const value = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(value)) return;
    setBusy(true);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code: value });
      if (error) {
        toast.error(twoFactorErrorText(error));
        setCode("");
        return;
      }
      await onChanged();
      setStep({ kind: "codes", backupCodes: step.backupCodes, fresh: true });
    } finally {
      setBusy(false);
    }
  }

  const title =
    step.kind === "manage"
      ? "Manage 2FA"
      : step.kind === "codes"
        ? "Save your backup codes"
        : step.kind === "scan"
          ? "Scan the QR code"
          : step.purpose === "disable"
            ? "Turn off 2FA"
            : step.purpose === "codes"
              ? "New backup codes"
              : "Set up 2FA";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {step.kind === "manage" &&
              "2FA is on. Logging in with your password also asks for a code from your authenticator app."}
            {step.kind === "password" && step.purpose === "enable" &&
              "With 2FA, each login with your password also asks for a 6‑digit code from an authenticator app, such as 1Password, Google Authenticator, Authy or Aegis. Enter your password to start."}
            {step.kind === "password" && step.purpose === "disable" &&
              "Logging in will only need your password again. Enter it to confirm."}
            {step.kind === "password" && step.purpose === "codes" &&
              "Your current backup codes stop working and you get ten new ones. Enter your password to continue."}
            {step.kind === "scan" &&
              "Scan it with your authenticator app, then enter the 6-digit code the app shows."}
            {step.kind === "codes" &&
              "If you lose your phone, each of these codes lets you log in once. Keep them somewhere safe, like a password manager. They won't be shown again."}
          </DialogDescription>
        </DialogHeader>

        {step.kind === "manage" && (
          <>
            <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-3">
              <ShieldCheck className="h-5 w-5 shrink-0 text-green-600 dark:text-green-500" />
              <p className="text-sm">
                Lost your phone? A backup code works instead of the app code. If you're running
                out, make new ones.
              </p>
            </div>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep({ kind: "password", purpose: "disable" })}
              >
                Turn off
              </Button>
              <Button type="button" onClick={() => setStep({ kind: "password", purpose: "codes" })}>
                New backup codes
              </Button>
            </DialogFooter>
          </>
        )}

        {step.kind === "password" && (
          <form onSubmit={submitPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="two-factor-password">Password</Label>
              <Input
                id="two-factor-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                required
              />
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => (enabled ? setStep({ kind: "manage" }) : handleOpenChange(false))}
                disabled={busy}
              >
                {enabled ? "Back" : "Cancel"}
              </Button>
              <Button
                type="submit"
                variant={step.purpose === "disable" ? "destructive" : "default"}
                disabled={busy || !password}
              >
                {busy
                  ? "Checking..."
                  : step.purpose === "disable"
                    ? "Turn off"
                    : step.purpose === "codes"
                      ? "Make new codes"
                      : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step.kind === "scan" && (
          <form onSubmit={submitCode} className="space-y-4">
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg border bg-white p-2">
                <QrCode value={step.totpURI} label="QR code for your authenticator app" />
              </div>
              <div className="w-full space-y-1 text-center">
                <p className="text-xs text-muted-foreground">Can't scan it? Enter this key in the app instead:</p>
                <div className="flex items-center justify-center gap-1">
                  <code className="max-w-[19rem] rounded bg-muted px-2 py-1 text-center font-mono text-xs leading-relaxed">
                    {manualEntryKey(step.totpURI)}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    aria-label="Copy key"
                    onClick={() => copy(manualEntryKey(step.totpURI).replace(/\s/g, ""), "key")}
                  >
                    {copied === "key" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="two-factor-setup-code">Code from the app</Label>
              <Input
                id="two-factor-setup-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
                disabled={busy}
                className="text-center font-mono text-lg tracking-[0.4em]"
              />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !/^\d{6}$/.test(code.replace(/\s/g, ""))}>
                {busy ? "Verifying..." : "Turn on"}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step.kind === "codes" && (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border bg-muted/40 px-4 py-3 font-mono text-sm">
              {step.backupCodes.map((backupCode) => (
                <span key={backupCode} className="text-center tracking-wide">
                  {backupCode}
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => copy(step.backupCodes.join("\n"), "codes")}
              >
                {copied === "codes" ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                {copied === "codes" ? "Copied" : "Copy"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => download(step.backupCodes)}
              >
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
            </div>
            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  if (step.fresh) toast.success("2FA is on");
                  handleOpenChange(false);
                }}
              >
                I saved them
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
