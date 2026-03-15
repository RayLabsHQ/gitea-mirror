// Base API URL
const API_BASE = "/api";

// Helper function for API requests
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      message: "An unknown error occurred",
    }));
    throw new Error(error.message || "An unknown error occurred");
  }

  return response.json();
}

// Auth API
export const authApi = {
  login: async (username: string, password: string) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // Send cookies
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) throw new Error("Login failed");
    return await res.json(); // returns user
  },

  register: async (username: string, email: string, password: string) => {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, email, password }),
    });

    if (!res.ok) throw new Error("Registration failed");
    return await res.json(); // returns user
  },

  getCurrentUser: async () => {
    const res = await fetch(`${API_BASE}/auth`, {
      method: "GET",
      credentials: "include", // Send cookies
    });

    if (!res.ok) throw new Error("Not authenticated");
    return await res.json();
  },

  logout: async () => {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  },
};

// GitHub API
export const githubApi = {
  testConnection: (token: string) =>
    apiRequest<{ success: boolean }>("/github/test-connection", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
};

// Gitea API
export const giteaApi = {
  testConnection: (url: string, token: string) =>
    apiRequest<{ success: boolean }>("/gitea/test-connection", {
      method: "POST",
      body: JSON.stringify({ url, token }),
    }),
};

// Health API
export interface HealthResponse {
  status: "ok" | "error" | "degraded";
  timestamp: string;
  version: string;
  latestVersion: string;
  updateAvailable: boolean;
  database: {
    connected: boolean;
  };
  recovery?: {
    status: string;
    jobsNeedingRecovery: number;
  };
  error?: string;
}

export const healthApi = {
  check: async (): Promise<HealthResponse> => {
    try {
      const response = await fetch(`${API_BASE}/health`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          status: "error",
          error: "Failed to parse error response",
        }));

        return {
          ...errorData,
          status: "error",
          timestamp: new Date().toISOString(),
        } as HealthResponse;
      }

      return await response.json();
    } catch (error) {
      return {
        status: "error",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error checking health",
        version: "unknown",
        latestVersion: "unknown",
        updateAvailable: false,
        database: { connected: false, message: "Failed to connect to API" },
        system: {
          uptime: { startTime: "", uptimeMs: 0, formatted: "N/A" },
          memory: {
            rss: "N/A",
            heapTotal: "N/A",
            heapUsed: "N/A",
            external: "N/A",
            systemTotal: "N/A",
            systemFree: "N/A",
          },
          os: { platform: "", version: "", arch: "" },
          env: "",
        },
      };
    }
  },
};
