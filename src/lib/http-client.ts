/**
 * HTTP client utility functions using fetch() for consistent error handling
 */

export interface HttpResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public response?: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Enhanced fetch with consistent error handling and JSON parsing
 */
export async function httpRequest<T = any>(
  url: string,
  options: RequestInit = {}
): Promise<HttpResponse<T>> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    // Clone response for error handling
    const responseClone = response.clone();

    if (!response.ok) {
      // The message carries the status only. The upstream body is kept on
      // `HttpError.response` for logs and for callers that inspect it, but
      // it never goes into the message: messages can reach API clients
      // through createSecureErrorResponse, and a URL under the user's
      // control would otherwise turn any error into a readable proxy of
      // whatever host it pointed at.
      const errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      let responseText = '';

      try {
        responseText = await responseClone.text();
      } catch {
        // Ignore text parsing errors
      }
      
      // Log authentication-specific errors for debugging
      if (response.status === 401) {
        console.error(`[HTTP Client] Authentication failed for ${url}`);
        console.error(`[HTTP Client] Response: ${responseText}`);
        if (responseText.includes('user does not exist') && responseText.includes('uid: 0')) {
          console.error(`[HTTP Client] Token appears to be invalid or the user account is not properly configured in Gitea`);
        }
      }

      throw new HttpError(
        errorMessage,
        response.status,
        response.statusText,
        responseText
      );
    }

    // Check content type for JSON responses
    const contentType = response.headers.get('content-type');
    let data: T;

    if (contentType && contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch (jsonError) {
        const responseText = await responseClone.text();

        // Enhanced JSON parsing error logging
        if (process.env.NODE_ENV !== 'test') {
          console.error("=== JSON PARSING ERROR ===");
          console.error("URL:", url);
          console.error("Status:", response.status, response.statusText);
          console.error("Content-Type:", contentType);
          console.error("Response length:", responseText.length);
          console.error("Response preview (first 500 chars):", responseText.substring(0, 500));
          console.error("JSON Error:", jsonError instanceof Error ? jsonError.message : String(jsonError));
          console.error("========================");
        }

        throw new HttpError(
          `Failed to parse JSON response from ${url}: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`,
          response.status,
          response.statusText,
          responseText
        );
      }
    } else {
      // For non-JSON responses, return text as data
      data = (await response.text()) as unknown as T;
    }

    return {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    // Handle network errors, etc.
    throw new HttpError(
      `Network error: ${error instanceof Error ? error.message : String(error)}`,
      0,
      'Network Error'
    );
  }
}

/**
 * GET request
 */
export async function httpGet<T = any>(
  url: string,
  headers?: Record<string, string>
): Promise<HttpResponse<T>> {
  return httpRequest<T>(url, {
    method: 'GET',
    headers,
  });
}

/**
 * POST request
 */
export async function httpPost<T = any>(
  url: string,
  body?: any,
  headers?: Record<string, string>
): Promise<HttpResponse<T>> {
  return httpRequest<T>(url, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * PUT request
 */
export async function httpPut<T = any>(
  url: string,
  body?: any,
  headers?: Record<string, string>
): Promise<HttpResponse<T>> {
  return httpRequest<T>(url, {
    method: 'PUT',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * PATCH request
 */
export async function httpPatch<T = any>(
  url: string,
  body?: any,
  headers?: Record<string, string>
): Promise<HttpResponse<T>> {
  return httpRequest<T>(url, {
    method: 'PATCH',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * DELETE request
 */
export async function httpDelete<T = any>(
  url: string,
  headers?: Record<string, string>
): Promise<HttpResponse<T>> {
  return httpRequest<T>(url, {
    method: 'DELETE',
    headers,
  });
}

/**
 * Gitea-specific HTTP client with authentication
 */
export class GiteaHttpClient {
  constructor(
    private baseUrl: string,
    private token: string
  ) {}

  private getHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
    return {
      'Authorization': `token ${this.token}`,
      'Content-Type': 'application/json',
      ...additionalHeaders,
    };
  }

  async get<T = any>(endpoint: string): Promise<HttpResponse<T>> {
    return httpGet<T>(`${this.baseUrl}${endpoint}`, this.getHeaders());
  }

  async post<T = any>(endpoint: string, body?: any): Promise<HttpResponse<T>> {
    return httpPost<T>(`${this.baseUrl}${endpoint}`, body, this.getHeaders());
  }

  async put<T = any>(endpoint: string, body?: any): Promise<HttpResponse<T>> {
    return httpPut<T>(`${this.baseUrl}${endpoint}`, body, this.getHeaders());
  }

  async patch<T = any>(endpoint: string, body?: any): Promise<HttpResponse<T>> {
    return httpPatch<T>(`${this.baseUrl}${endpoint}`, body, this.getHeaders());
  }

  async delete<T = any>(endpoint: string): Promise<HttpResponse<T>> {
    return httpDelete<T>(`${this.baseUrl}${endpoint}`, this.getHeaders());
  }
}
