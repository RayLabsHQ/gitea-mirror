import * as React from "react";
import {
  useState,
  useEffect,
  createContext,
  useContext,
  type Context,
} from "react";
import { authClient, useSession as useBetterAuthSession } from "@/lib/auth-client";
import type { Session, AuthUser } from "@/lib/auth-client";
import { withBase } from "@/lib/base-path";
import { isAuthRedirect, type AuthRedirectData } from "@/lib/auth-redirect";

interface AuthContextType {
  user: AuthUser | null;
  session: Session | null;
  isLoading: boolean;
  error: string | null;
  /** Resolves with twoFactorRequired when the account asks for a code next (#552). */
  /**
   * `twoFactorRequired`: the password was right and a code is needed next.
   * `redirecting`: the client is already on its way to an app's callback.
   */
  login: (email: string, password: string) => Promise<{ twoFactorRequired: boolean; redirecting: boolean }>;
  register: (
    username: string,
    email: string,
    password: string
  ) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext: Context<AuthContextType | undefined> = createContext<
  AuthContextType | undefined
>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const betterAuthSession = useBetterAuthSession();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Derive user and session from Better Auth hook
  const user = betterAuthSession.data?.user || null;
  const session = betterAuthSession.data || null;

  // Don't do any redirects here - let the pages handle their own redirect logic

  const login = async (email: string, password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({
        email,
        password,
        callbackURL: withBase("/"),
      });
      
      if (result.error) {
        throw new Error(result.error.message || "Login failed");
      }
      // The password was right, but no session yet: the two-factor plugin
      // wants a code from the authenticator app or a backup code (#552).
      const data = result.data as AuthRedirectData | null;
      return { twoFactorRequired: data?.twoFactorRedirect === true, redirecting: isAuthRedirect(data) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (
    username: string,
    email: string,
    password: string
  ) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await authClient.signUp.email({
        email,
        password,
        name: username, // Better Auth uses 'name' field for display name
        callbackURL: withBase("/"),
      });

      if (result.error) {
        throw new Error(result.error.message || "Registration failed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Registration failed";
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            window.location.href = withBase("/login");
          },
        },
      });
    } catch (err) {
      console.error("Logout error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const refreshUser = async () => {
    // Better Auth automatically handles session refresh
    // We can force a refetch if needed
    await betterAuthSession.refetch();
  };

  // Create the context value
  const contextValue = {
    user: user as AuthUser | null,
    session: session as Session | null,
    isLoading: isLoading || betterAuthSession.isPending,
    error,
    login,
    register,
    logout,
    refreshUser,
  };

  // Return the provider with the context value
  return React.createElement(
    AuthContext.Provider,
    { value: contextValue },
    children
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

// Export the Better Auth session hook for direct use when needed
export { useBetterAuthSession };
