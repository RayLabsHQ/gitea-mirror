import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { isAuthRedirect, type AuthRedirectData } from "@/lib/auth-redirect";
import { twoFactorErrorText } from "@/lib/two-factor-ui";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ShieldCheck } from "lucide-react";

type Mode = "app" | "backup";

/** Errors that end this sign-in attempt: the password has to be entered again. */
const RESTART_ERRORS = new Set([
  "INVALID_TWO_FACTOR_COOKIE",
  "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
]);

/**
 * The second login step (#552): a code from the authenticator app, or one of
 * the backup codes, with "Trust this device" off by default.
 */
export function TwoFactorChallenge({
  onVerified,
  onCancel,
}: {
  /** `redirecting`: the client is already on its way to an app's callback. */
  onVerified: (redirecting: boolean) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<Mode>("app");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const appCode = code.replace(/\s/g, "");
  const ready = mode === "app" ? /^\d{6}$/.test(appCode) : code.trim().length > 0;

  async function verify(value: string) {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const { data, error } =
        mode === "app"
          ? await authClient.twoFactor.verifyTotp({ code: value, trustDevice })
          : await authClient.twoFactor.verifyBackupCode({ code: value, trustDevice });
      if (error) {
        toast.error(twoFactorErrorText(error));
        setCode("");
        if (error.code && RESTART_ERRORS.has(error.code)) onCancel();
        else inputRef.current?.focus();
        return;
      }
      onVerified(isAuthRedirect(data as AuthRedirectData | null));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    void verify(mode === "app" ? appCode : code.trim());
  }

  function switchMode(next: Mode) {
    setMode(next);
    setCode("");
  }

  return (
    <form onSubmit={handleSubmit}>
      <CardContent className="space-y-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-5 w-5 text-primary" />
          </div>
          <p className="text-sm font-medium">
            {mode === "app" ? "Enter the code from your authenticator app" : "Enter a backup code"}
          </p>
          <p className="text-xs text-muted-foreground">
            {mode === "app"
              ? "Open the app and type the 6-digit code shown for Gitea Mirror."
              : "Use one of the codes you saved when you set up 2FA. Each code works once."}
          </p>
        </div>

        {mode === "app" ? (
          <input
            ref={inputRef}
            id="two-factor-code"
            name="code"
            aria-label="Authentication code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={7}
            placeholder="000000"
            value={code}
            onChange={(e) => {
              const next = e.target.value.replace(/[^\d ]/g, "");
              setCode(next);
              // Six digits is a whole code: verify without another click.
              const digits = next.replace(/\s/g, "");
              if (/^\d{6}$/.test(digits)) void verify(digits);
            }}
            disabled={isSubmitting}
            className="w-full rounded-md border border-input bg-background px-3 py-3 text-center font-mono text-2xl tracking-[0.5em] shadow-sm transition-colors placeholder:text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        ) : (
          <input
            ref={inputRef}
            id="two-factor-backup-code"
            name="backup-code"
            aria-label="Backup code"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="xxxxx-xxxxx"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={isSubmitting}
            className="w-full rounded-md border border-input bg-background px-3 py-3 text-center font-mono text-lg tracking-wider shadow-sm transition-colors placeholder:text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        )}

        <div className="flex items-start gap-2">
          <Checkbox
            id="trust-device"
            checked={trustDevice}
            onCheckedChange={(checked) => setTrustDevice(checked === true)}
            disabled={isSubmitting}
            className="mt-0.5"
          />
          <div className="grid gap-0.5">
            <Label htmlFor="trust-device" className="cursor-pointer text-sm font-normal">
              Trust this device for 30 days
            </Label>
            <p className="text-xs text-muted-foreground">
              Skip the code when you log in from this browser. Only use this on your own device.
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex flex-col gap-3">
        <Button type="submit" className="w-full" disabled={isSubmitting || !ready}>
          {isSubmitting ? "Verifying..." : "Verify"}
        </Button>
        <div className="flex w-full items-center justify-between text-xs">
          <button
            type="button"
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Back to login
          </button>
          <button
            type="button"
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => switchMode(mode === "app" ? "backup" : "app")}
            disabled={isSubmitting}
          >
            {mode === "app" ? "Use a backup code" : "Use the authenticator app"}
          </button>
        </div>
      </CardFooter>
    </form>
  );
}
