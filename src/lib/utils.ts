import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { httpRequest, HttpError } from "@/lib/http-client";
import type { RepoStatus } from "@/types/Repository";

export const API_BASE = "/api";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function formatDate(date?: Date | string | null): string {
  if (!date) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

export function formatDateShort(date?: Date | string | null): string | undefined {
  if (!date) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}

export function formatLastSyncTime(date: Date | string | null): string {
  if (!date) return "Never";
  
  const now = new Date();
  const syncDate = new Date(date);
  const diffMs = now.getTime() - syncDate.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  // Show relative time for recent syncs
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hr${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  
  // For older syncs, show week count
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 4) return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`;
  
  // For even older, show month count
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + "...";
}

export function safeParse<T>(value: unknown): T | undefined {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return value as T;
}

// Enhanced error message parsing for toast notifications
export interface ParsedErrorMessage {
  title: string;
  description?: string;
  isStructured: boolean;
}

function getInvalidOriginGuidance(title: string, description?: string): ParsedErrorMessage | null {
  const fullMessage = `${title} ${description ?? ""}`.trim();
  if (!/invalid origin/i.test(fullMessage)) {
    return null;
  }

  const urlMatch = fullMessage.match(/https?:\/\/[^\s'")]+/i);
  let originHint = "this URL";

  if (urlMatch) {
    try {
      originHint = new URL(urlMatch[0]).origin;
    } catch {
      originHint = urlMatch[0];
    }
  }

  return {
    title: "Invalid Origin",
    description: `Add ${originHint} to BETTER_AUTH_TRUSTED_ORIGINS and restart the app.`,
    isStructured: true,
  };
}

export function parseErrorMessage(error: unknown): ParsedErrorMessage {
  // Handle Error objects
  if (error instanceof Error) {
    return parseErrorMessage(error.message);
  }

  // Handle string messages
  if (typeof error === "string") {
    // Try to parse as JSON first
    try {
      const parsed = JSON.parse(error);

      // Check for common structured error formats
      if (typeof parsed === "object" && parsed !== null) {
        // Format 1: { error: "message", errorType: "type", troubleshooting: "info" }
        if (parsed.error) {
          const formatted = {
            title: parsed.error,
            description: parsed.troubleshooting || parsed.errorType || undefined,
            isStructured: true,
          };
          return getInvalidOriginGuidance(formatted.title, formatted.description) || formatted;
        }

        // Format 2: { title: "title", description: "desc" }
        if (parsed.title) {
          const formatted = {
            title: parsed.title,
            description: parsed.description || undefined,
            isStructured: true,
          };
          return getInvalidOriginGuidance(formatted.title, formatted.description) || formatted;
        }

        // Format 3: { message: "msg", details: "details" }
        if (parsed.message) {
          const formatted = {
            title: parsed.message,
            description: parsed.details || undefined,
            isStructured: true,
          };
          return getInvalidOriginGuidance(formatted.title, formatted.description) || formatted;
        }
      }
    } catch {
      // Not valid JSON, treat as plain string
    }

    // Plain string message
    const formatted = {
      title: error,
      description: undefined,
      isStructured: false,
    };
    return getInvalidOriginGuidance(formatted.title, formatted.description) || formatted;
  }

  // Handle objects directly
  if (typeof error === "object" && error !== null) {
    const errorObj = error as any;

    if (errorObj.error) {
      const formatted = {
        title: errorObj.error,
        description: errorObj.troubleshooting || errorObj.errorType || undefined,
        isStructured: true,
      };
      return getInvalidOriginGuidance(formatted.title, formatted.description) || formatted;
    }

    if (errorObj.title) {
      const formatted = {
        title: errorObj.title,
        description: errorObj.description || undefined,
        isStructured: true,
      };
      return getInvalidOriginGuidance(formatted.title, formatted.description) || formatted;
    }

    if (errorObj.message) {
      const formatted = {
        title: errorObj.message,
        description: errorObj.details || undefined,
        isStructured: true,
      };
      return getInvalidOriginGuidance(formatted.title, formatted.description) || formatted;
    }
  }

  // Fallback for unknown types
  const fallback = {
    title: String(error),
    description: undefined,
    isStructured: false,
  };
  return getInvalidOriginGuidance(fallback.title, fallback.description) || fallback;
}

// Enhanced toast helper that parses structured error messages
export function showErrorToast(error: unknown, toast: any) {
  const parsed = parseErrorMessage(error);

  if (parsed.description) {
    // Use sonner's rich toast format with title and description
    toast.error(parsed.title, {
      description: parsed.description,
    });
  } else {
    // Simple error toast
    toast.error(parsed.title);
  }
}

// Helper function for API requests

export async function apiRequest<T>(
  endpoint: string,
  options: (RequestInit & { data?: any }) = {}
): Promise<T> {
  try {
    // Handle the custom 'data' property by converting it to 'body'
    const { data, ...requestOptions } = options;
    const finalOptions: RequestInit = {
      headers: {
        "Content-Type": "application/json",
        ...(requestOptions.headers || {}),
      },
      ...requestOptions,
    };

    // If data is provided, stringify it and set as body
    if (data !== undefined) {
      finalOptions.body = JSON.stringify(data);
    }

    const response = await httpRequest<T>(`${API_BASE}${endpoint}`, finalOptions);

    return response.data;
  } catch (err) {
    const error = err as HttpError;

    const message =
      error.response ||
      error.message ||
      "An unknown error occurred";

    throw new Error(message);
  }
}

export const getStatusColor = (status: string): string => {
  switch (status) {
    case "imported":
      return "bg-yellow-500"; // Ready to mirror
    case "mirroring":
      return "bg-amber-500"; // In progress
    case "mirrored":
      return "bg-green-500"; // Successfully mirrored
    case "failed":
      return "bg-red-500"; // Error
    case "syncing":
      return "bg-blue-500"; // Sync in progress
    case "synced":
      return "bg-emerald-500"; // Successfully synced
    case "skipped":
      return "bg-gray-500"; // Skipped
    case "deleting":
      return "bg-orange-500"; // Deleting
    case "deleted":
      return "bg-gray-600"; // Deleted
    default:
      return "bg-gray-400"; // Unknown/neutral
  }
};

export const jsonResponse = ({
  data,
  status = 200,
}: {
  data: unknown;
  status?: number;
}): Response => {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * Securely handles errors for API responses by sanitizing error messages
 * and preventing sensitive information exposure while maintaining proper logging
 */
export function createSecureErrorResponse(
  error: unknown,
  context: string,
  status: number = 500
): Response {
  // Log the full error details server-side for debugging
  console.error(`Error in ${context}:`, error);

  // Log additional error details if it's an Error object
  if (error instanceof Error) {
    console.error(`Error name: ${error.name}`);
    console.error(`Error message: ${error.message}`);
    if (error.stack) {
      console.error(`Error stack: ${error.stack}`);
    }
  }

  // Determine safe error message for client
  let clientMessage = "An internal server error occurred";

  // Only expose specific safe error types to clients
  if (error instanceof Error) {
    // Safe error patterns that can be exposed (add more as needed)
    const safeErrorPatterns = [
      /missing required field/i,
      /invalid.*format/i,
      /not found/i,
      /unauthorized/i,
      /forbidden/i,
      /bad request/i,
      /validation.*failed/i,
      /user id is required/i,
      /no repositories found/i,
      /config missing/i,
      /invalid userid/i,
      /no users found/i,
      /missing userid/i,
      /github token is required/i,
      /invalid github token/i,
      /invalid gitea token/i,
      /username and password are required/i,
      /invalid username or password/i,
      /organization already exists/i,
      /no configuration found/i,
      /github token is missing/i,
      /use post method/i,
    ];

    const isSafeError = safeErrorPatterns.some(pattern =>
      pattern.test(error.message)
    );

    if (isSafeError) {
      clientMessage = error.message;
    }
  }

  return new Response(
    JSON.stringify({
      error: clientMessage,
      timestamp: new Date().toISOString(),
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}
