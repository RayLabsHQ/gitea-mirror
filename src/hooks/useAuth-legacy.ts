import * as React from "react";
import {
  useState,
  useEffect,
  createContext,
  useContext,
  type Context,
} from "react";
import { authApi } from "@/lib/api";
import type { ExtendedUser } from "@/types/user";
import { withBase } from "@/lib/base-path";

interface AuthContextType {
  user: ExtendedUser | null;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (
    username: string,
    email: string,
    password: string
  ) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>; // Added refreshUser function
}

const AuthContext: Context<AuthContextType | undefined> = createContext<
  AuthContextType | undefined
>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<ExtendedUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Function to refetch the user data
  const refreshUser = async () => {
    // not using loading state to keep the ui seamless and refresh the data in bg
    // setIsLoading(true);
    try {
      const user = await authApi.getCurrentUser();
      setUser(user);
    } catch (err: any) {
      setUser(null);
      console.error("Failed to refresh user data", err);
    } finally {
      // setIsLoading(false);
    }
  };

  // Automatically check the user status when the app loads
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const user = await authApi.getCurrentUser();

        console.log("User data fetched:", user);

        setUser(user);
      } catch (err: any) {
        setUser(null);

        // Redirect user based on error
        if (err?.message === "No users found") {
          window.location.href = withBase("/signup");
        } else {
          window.location.href = withBase("/login");
        }
        console.error("Auth check failed", err);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, []);

  const login = async (username: string, password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const user = await authApi.login(username, password);
      setUser(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
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
      const user = await authApi.register(username, email, password);
      setUser(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await authApi.logout();
      setUser(null);
      window.location.href = withBase("/login");
    } catch (err) {
      console.error("Logout error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  // Create the context value with the added refreshUser function
  const contextValue = {
    user,
    isLoading,
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
