import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, LogOut, Mail, ShieldCheck } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { authClient } from "@/lib/auth-client";
import { withBase } from "@/lib/base-path";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { ChangeEmailDialog } from "./ChangeEmailDialog";
import { TwoFactorDialog } from "./TwoFactorDialog";

export function AccountMenu() {
  const { user, logout, refreshUser } = useAuth();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);

  useEffect(() => {
    if (!user) {
      setHasPassword(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const accounts = await authClient.listAccounts();
        if (cancelled) return;
        const list = Array.isArray(accounts) ? accounts : accounts?.data;
        setHasPassword(
          Array.isArray(list) && list.some((a) => a.providerId === "credential")
        );
      } catch {
        // Fail open: if we can't check, show the option rather than locking the
        // user out of changing their password.
        if (!cancelled) setHasPassword(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (!user) {
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={withBase("/login")}>Login</a>
      </Button>
    );
  }

  const handleLogout = async () => {
    toast.success("Logged out successfully");
    await new Promise((resolve) => setTimeout(resolve, 500));
    logout();
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="lg"
            className="relative h-10 w-10 rounded-full p-0"
          >
            <Avatar className="h-full w-full">
              <AvatarImage src={user.image || ""} alt={user.name || user.email} />
              <AvatarFallback>
                {(user.name || user.email || "U").charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-0.5">
              {user.name && (
                <span className="text-sm font-medium leading-none">
                  {user.name}
                </span>
              )}
              <span className="text-xs leading-none text-muted-foreground truncate">
                {user.email}
              </span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {hasPassword && (
            <DropdownMenuItem
              onSelect={() => setPasswordOpen(true)}
              className="cursor-pointer"
            >
              <KeyRound className="h-4 w-4 mr-2" />
              Change password
            </DropdownMenuItem>
          )}
          {/* 2FA only guards the password login, so it needs a password (#552).
              Off, the item offers the setup; on, it opens Manage 2FA. */}
          {hasPassword && (
            <DropdownMenuItem
              onSelect={() => setTwoFactorOpen(true)}
              className="cursor-pointer"
            >
              <ShieldCheck className="h-4 w-4 mr-2" />
              2FA
              {user.twoFactorEnabled ? (
                <span className="ml-auto text-xs font-medium text-green-600 dark:text-green-500">On</span>
              ) : (
                <span className="ml-auto rounded-md border px-1.5 py-0.5 text-xs font-medium leading-none">Set up</span>
              )}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => setEmailOpen(true)}
            className="cursor-pointer"
          >
            <Mail className="h-4 w-4 mr-2" />
            Change email
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleLogout} className="cursor-pointer">
            <LogOut className="h-4 w-4 mr-2" />
            Logout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {hasPassword && (
        <ChangePasswordDialog
          open={passwordOpen}
          onOpenChange={setPasswordOpen}
        />
      )}
      {hasPassword && (
        <TwoFactorDialog
          open={twoFactorOpen}
          onOpenChange={setTwoFactorOpen}
          enabled={user.twoFactorEnabled === true}
          onChanged={refreshUser}
        />
      )}
      <ChangeEmailDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        currentEmail={user.email}
        onUpdated={refreshUser}
      />
    </>
  );
}
